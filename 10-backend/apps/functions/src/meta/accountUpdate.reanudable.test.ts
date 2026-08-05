import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * H3 (Codex Security, MEDIUM) — UN `account_update` NO SE CONSUME HASTA COMPLETAR SUS EFECTOS.
 * ============================================================================================
 * El handler creaba un claim PERMANENTE (create) ANTES de degradar, cerrar la generación y
 * auditar. Si cualquier efecto posterior fallaba, la redelivery de Meta encontraba el claim y
 * respondía «reentrega» para siempre: el número quedaba a medio degradar sin que nadie lo
 * reintentara nunca — un evento de SEGURIDAD parcialmente aplicado y no reanudable.
 *
 * Lo que este archivo exige:
 *  · la idempotencia se modela como COMPLETITUD: solo un claim `completed` deduplica de verdad;
 *  · un fallo en los efectos deja el evento REANUDABLE: la redelivery retoma y termina el cierre
 *    (los efectos ya son idempotentes: merges y cierre honesto);
 *  · dos deliveries concurrentes tienen UN solo dueño;
 *  · DIFERIDO (timestamp null de Meta): sin `timestamp` no se puede distinguir la reentrega de
 *    una desconexión nueva ⇒ fail-closed: se vuelve a aplicar (re-degradar de más es seguro;
 *    tragarse una desconexión real es el desenlace prohibido).
 */

const docs = new Map<string, Record<string, unknown>>();
/** Versión por documento: contención REAL para el doble de transacción (patrón historyCoordinator). */
const versiones = new Map<string, number>();

interface Op { path: string; data: Record<string, unknown>; merge: boolean }

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const auditorias: Array<Record<string, unknown>> = [];
vi.mock('../audit/audit.js', () => ({ recordAudit: async (e: Record<string, unknown>) => { auditorias.push(e); } }));

/** El cierre de la generación es el EFECTO cuyo fallo dispara el escenario del hallazgo. */
const cerrarGeneracion = vi.fn(async () => undefined);
vi.mock('./historyCoordinator.js', () => ({
  cerrarGeneracionPorOffboarding: (...a: unknown[]) => cerrarGeneracion(...(a as [])),
}));

const escribir = (path: string, data: Record<string, unknown>, merge: boolean): void => {
  docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
  versiones.set(path, (versiones.get(path) ?? 0) + 1);
};

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      // Snapshot al momento de la lectura, como el SDK real (un `data()` perezoso linealiza).
      get: async () => {
        const d = docs.get(path);
        return { exists: d !== undefined, data: () => d };
      },
      create: async (data: Record<string, unknown>) => {
        if (docs.has(path)) throw Object.assign(new Error('already exists'), { code: 6 });
        escribir(path, data, false);
      },
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => escribir(path, data, opts?.merge === true),
    }),
    batch: () => {
      const ops: Op[] = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
          ops.push({ path: ref.path, data, merge: opts?.merge === true }),
        commit: async () => { for (const o of ops) escribir(o.path, o.data, o.merge); },
      };
    },
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      for (let intento = 0; intento < 5; intento++) {
        const leidos = new Map<string, number>();
        const ops: Op[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            leidos.set(ref.path, versiones.get(ref.path) ?? 0);
            const d = docs.get(ref.path);
            return { exists: d !== undefined, data: () => d };
          },
          set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
            ops.push({ path: ref.path, data, merge: opts?.merge === true }),
          update: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ path: ref.path, data, merge: true }),
        };
        const r = await fn(tx);
        const chocó = [...leidos].some(([p, v]) => (versiones.get(p) ?? 0) !== v);
        if (chocó) continue;
        for (const op of ops) escribir(op.path, op.data, op.merge);
        return r;
      }
      throw new Error('transacción abortada por contención');
    },
  }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

import { aplicarAccountUpdate } from './accountUpdate.js';
import type { NormalizedAccountUpdate } from './parseWebhook.js';

const TENANT = 'tnt_alpha';
const PNID = '900000002';
const T0 = 1_754_200_000_000;
const assetPath = `tenants/${TENANT}/metaAssets/${PNID}`;
const idxPath = `metaExternalIndex/whatsapp_${PNID}`;

const evento = (over: Partial<NormalizedAccountUpdate> = {}): NormalizedAccountUpdate => ({
  platform: 'whatsapp', externalId: PNID, wabaId: 'WABA_ID', event: 'ACCOUNT_OFFBOARDED',
  rawEvent: 'ACCOUNT_OFFBOARDED', timestamp: T0 / 1000, ...over,
});

const sembrar = (): void => {
  escribir(assetPath, {
    id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number',
    externalId: PNID, status: 'active', selected: false, automationMode: 'live', sessionKey: `wa_${PNID}`,
  }, false);
  escribir(idxPath, { id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: `wa_${PNID}`, externalId: PNID, status: 'active' }, false);
};

/** La recuperación documentada: un humano re-promueve el número entre entrega y reentrega. */
const repromover = (): void => {
  escribir(assetPath, { automationMode: 'live' }, true);
  escribir(idxPath, { automationMode: 'live' }, true);
};

beforeEach(() => {
  docs.clear();
  versiones.clear();
  auditorias.length = 0;
  cerrarGeneracion.mockClear();
  cerrarGeneracion.mockImplementation(async () => undefined);
});

describe('el claim se consuma con los EFECTOS, no antes (H3)', () => {
  it('si un efecto posterior falla, la redelivery RETOMA y termina el cierre', async () => {
    sembrar();
    // El cierre de la generación falla en la primera entrega (hipo transitorio de Firestore).
    cerrarGeneracion.mockRejectedValueOnce(new Error('UNAVAILABLE'));

    const primera = await aplicarAccountUpdate(evento(), T0);
    expect(primera).toEqual({ aplicado: false, motivo: 'error' });
    expect(cerrarGeneracion).toHaveBeenCalledTimes(1);
    // Estado a medio aplicar: degradado pero sin cierre de generación ni auditoría.
    expect(auditorias).toHaveLength(0);

    // La redelivery de Meta llega un minuto después, con el MISMO evento.
    const segunda = await aplicarAccountUpdate(evento(), T0 + 60_000);

    expect(segunda, 'la redelivery tiene que poder terminar el trabajo').toEqual({ aplicado: true, accion: 'degradado', tenantId: TENANT });
    expect(cerrarGeneracion, 'el cierre de la generación se reintenta').toHaveBeenCalledTimes(2);
    expect(auditorias, 'y la auditoría queda registrada exactamente una vez').toHaveLength(1);
    expect(docs.get(assetPath)!['automationMode']).toBe('inactive');
  });

  it('solo un claim COMPLETADO deduplica: el ciclo entero aplicado no se repite', async () => {
    sembrar();
    await aplicarAccountUpdate(evento(), T0);
    expect(auditorias).toHaveLength(1);
    // La recuperación documentada re-promovió el número.
    repromover();
    cerrarGeneracion.mockClear();

    const r = await aplicarAccountUpdate(evento(), T0 + 60_000);

    expect(r).toEqual({ aplicado: false, motivo: 'reentrega' });
    expect(cerrarGeneracion).not.toHaveBeenCalled();
    expect(auditorias, 'la auditoría no se duplica').toHaveLength(1);
    expect(docs.get(assetPath)!['automationMode'], 'la reentrega no re-degrada al re-promovido').toBe('live');
  });

  it('un claim en PROCESO (otro dueño, lease vivo) corta sin efectos', async () => {
    sembrar();
    // Claim tomado hace UN segundo por otra invocación que sigue viva.
    escribir(`metaAccountUpdates/au_${PNID}_ACCOUNT_OFFBOARDED_${T0}`, {
      tenantId: TENANT, event: 'ACCOUNT_OFFBOARDED', status: 'processing',
      claimedAt: { toMillis: () => T0 - 1_000 },
    }, false);

    const r = await aplicarAccountUpdate(evento(), T0);

    expect(r.aplicado).toBe(false);
    expect(cerrarGeneracion).not.toHaveBeenCalled();
    expect(auditorias).toHaveLength(0);
    expect(docs.get(assetPath)!['automationMode'], 'el segundo dueño no toca nada').toBe('live');
  });

  it('un claim en proceso con lease MUERTO (la corrida murió) se retoma', async () => {
    sembrar();
    // Claim tomado hace 10 minutos: holgadamente más que cualquier lease razonable de un webhook.
    escribir(`metaAccountUpdates/au_${PNID}_ACCOUNT_OFFBOARDED_${T0}`, {
      tenantId: TENANT, event: 'ACCOUNT_OFFBOARDED', status: 'processing',
      claimedAt: { toMillis: () => T0 - 10 * 60 * 1000 },
    }, false);

    const r = await aplicarAccountUpdate(evento(), T0);

    expect(r).toEqual({ aplicado: true, accion: 'degradado', tenantId: TENANT });
    expect(docs.get(assetPath)!['automationMode']).toBe('inactive');
  });

  it('dos deliveries CONCURRENTES: un solo dueño, efectos una sola vez', async () => {
    sembrar();

    const [a, b] = await Promise.all([
      aplicarAccountUpdate(evento(), T0),
      aplicarAccountUpdate(evento(), T0 + 1),
    ]);

    expect([a.aplicado, b.aplicado].filter(Boolean), 'exactamente uno aplica').toHaveLength(1);
    expect(cerrarGeneracion).toHaveBeenCalledTimes(1);
    expect(auditorias).toHaveLength(1);
  });
});

describe('DIFERIDO — timestamp null de Meta (contrato sin confirmar, Programa 2)', () => {
  it('sin timestamp NO se puede fingir dedup: una desconexión posterior vuelve a degradar', async () => {
    sembrar();

    const primera = await aplicarAccountUpdate(evento({ timestamp: null }), T0);
    expect(primera).toEqual({ aplicado: true, accion: 'degradado', tenantId: TENANT });

    // Un humano re-promueve; una hora después llega OTRO offboarding, también sin timestamp.
    // Sin el campo no hay forma de distinguirlo de la reentrega: fail-closed es re-aplicar
    // (un número degradado de más se recupera con una escritura; uno que sigue automatizando
    // contra una conexión muerta es el desenlace prohibido).
    repromover();

    const segunda = await aplicarAccountUpdate(evento({ timestamp: null }), T0 + 3_600_000);

    expect(segunda).toEqual({ aplicado: true, accion: 'degradado', tenantId: TENANT });
    expect(docs.get(assetPath)!['automationMode']).toBe('inactive');
    expect(docs.get(idxPath)!['automationMode']).toBe('inactive');
  });
});
