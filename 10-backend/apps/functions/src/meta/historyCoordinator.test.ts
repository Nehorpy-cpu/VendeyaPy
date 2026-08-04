/**
 * historyCoordinator.test.ts — el disparo único, la ventana de 24 h y la completitud honesta
 * ===========================================================================================
 * ADR-0017 §5. El contrato oficial dice que la sincronización del historial se pide UNA sola vez y
 * que repetirla exige que el cliente offboardee el número y vuelva a completar el Embedded Signup
 * — sobre un número con clientes vivos. Todo lo que sigue custodia esa frase:
 *
 *  · el disparo se reclama TRANSACCIONALMENTE, así que dos invocaciones concurrentes no disparan dos;
 *  · sin decisión humana explícita y previa, no se dispara (y la opción segura por defecto es NO);
 *  · la ventana corre desde el ONBOARDING, no desde el disparo;
 *  · «no compartió» (2593109) es un desenlace, no un silencio;
 *  · los chunks duplicados, REORDENADOS y reintentados no mueven el resultado;
 *  · y un fallo de persistencia NUNCA termina en `completed`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
/** Versión por documento: es lo que le da CONTENCIÓN real al doble de transacción. */
const versiones = new Map<string, number>();

interface Op { path: string; data: Record<string, unknown>; merge?: boolean }

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/**
 * El doble de Firestore modela lo ÚNICO que importa acá y que un `Map` no da gratis: una
 * transacción no puede commitear si un documento que leyó cambió en el medio, y el SDK reintenta
 * el cuerpo. Sin esto, «dos reclamos concurrentes» sería un test que siempre pasa —los dos leerían
 * `pending_request`— y la garantía del disparo único no estaría probada, sólo escrita.
 */
vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
        versiones.set(path, (versiones.get(path) ?? 0) + 1);
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      for (let intento = 0; intento < 5; intento++) {
        const leidos = new Map<string, number>();
        const ops: Op[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            leidos.set(ref.path, versiones.get(ref.path) ?? 0);
            return { exists: docs.has(ref.path), data: () => docs.get(ref.path) };
          },
          set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ path: ref.path, data, merge: opts?.merge }),
        };
        const r = await fn(tx);
        const chocó = [...leidos].some(([p, v]) => (versiones.get(p) ?? 0) !== v);
        if (chocó) continue; // el SDK real reintenta el cuerpo con la lectura fresca
        for (const op of ops) {
          docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data } : { ...op.data });
          versiones.set(op.path, (versiones.get(op.path) ?? 0) + 1);
        }
        return r;
      }
      throw new Error('transacción abortada por contención');
    },
  }),
  paths: {},
}));

import {
  acumularObservaciones,
  chunkKey,
  coexistenceHistorySyncPath,
  esEstadoTerminal,
  leerCoordinador,
  puedeDisparar,
  reclamarDisparo,
  registrarDecisionDeHistorial,
  registrarObservaciones,
  registrarResultadoDelDisparo,
  vencido,
  HISTORY_SYNC_WINDOW_MS,
  type ChunkObservado,
} from './historyCoordinator.js';

const TENANT = 'tnt_alpha';
const PNID = '900000002';
const CONEXION = `wa_${PNID}`;
const RUTA = coexistenceHistorySyncPath(TENANT, PNID);
const T0 = 1_754_200_000_000; // onboarding
const ts = (ms: number) => ({ toMillis: () => ms });

const obs = (over: Partial<ChunkObservado> = {}): ChunkObservado => ({
  phase: 0, chunkOrder: 1, progress: 50, nuevo: true, persistido: true, tenantResuelto: true, declinado: false, ...over,
});

const decidir = (decision: 'share' | 'skip') =>
  registrarDecisionDeHistorial({ tenantId: TENANT, phoneNumberId: PNID, connectionId: CONEXION, decision, actorUid: 'uid-owner', onboardedAtMs: T0, nowMs: T0 + 60_000 });

beforeEach(() => { docs.clear(); versiones.clear(); vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// La decisión HUMANA, explícita y PREVIA
// ---------------------------------------------------------------------------

describe('la decisión de compartir es humana, explícita y previa', () => {
  it('sin coordinador NO se puede disparar: la opción segura por defecto es no compartir', () => {
    const v = puedeDisparar(null, T0);
    expect(v.puede).toBe(false);
    expect(v.motivo).toBe('sin_coordinador');
    expect(v.explicacion).toMatch(/decidir/i);
  });

  it('con coordinador pero SIN decisión tampoco', () => {
    expect(puedeDisparar({ status: 'pending_request', sharingDecision: null }, T0).motivo).toBe('sin_decision');
  });

  it('`skip` es terminal y lo dice: revertirlo exige rehacer el Embedded Signup', async () => {
    const r = await decidir('skip');

    expect(r).toMatchObject({ ok: true, status: 'declined' });
    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('declined');
    expect(puedeDisparar(coord, T0 + 120_000)).toMatchObject({ puede: false, motivo: 'no_compartir' });
  });

  it('`share` deja el coordinador listo para UN disparo, con el deadline desde el ONBOARDING', async () => {
    const r = await decidir('share');

    expect(r).toMatchObject({ ok: true, status: 'pending_request', syncGeneration: 1 });
    expect((r as { deadlineAtMs: number }).deadlineAtMs).toBe(T0 + HISTORY_SYNC_WINDOW_MS);
    // El deadline NO se calcula desde el disparo: el reloj de Meta arranca en el onboarding.
    expect((docs.get(RUTA)!['onboardedAt'] as { toMillis(): number }).toMillis()).toBe(T0);
  });

  it('una segunda decisión no pisa la primera', async () => {
    await decidir('share');
    const r = await decidir('skip');
    expect(r).toMatchObject({ ok: false, reason: 'ya_decidido' });
    expect((await leerCoordinador(TENANT, PNID))!.status).toBe('pending_request');
  });

  it('el coordinador no guarda PII: ni wa_id, ni teléfonos, ni textos', async () => {
    await decidir('share');
    const claves = Object.keys(docs.get(RUTA)!);
    for (const prohibida of ['customerId', 'wa_id', 'text', 'messages', 'threads', 'displayPhoneNumber']) {
      expect(claves).not.toContain(prohibida);
    }
  });
});

// ---------------------------------------------------------------------------
// UNA sola vez
// ---------------------------------------------------------------------------

describe('el disparo se usa UNA sola vez, y el rechazo dice por qué', () => {
  it('el primer reclamo gana y deja el estado en `requested`', async () => {
    await decidir('share');

    const r = await reclamarDisparo(TENANT, PNID, T0 + 120_000);

    expect(r).toEqual({ ok: true, syncGeneration: 1 });
    expect(docs.get(RUTA)!['status']).toBe('requested');
    expect((docs.get(RUTA)!['requestedAt'] as { toMillis(): number }).toMillis()).toBe(T0 + 120_000);
  });

  it('el SEGUNDO reclamo se rechaza y explica que hay que rehacer el Embedded Signup', async () => {
    await decidir('share');
    await reclamarDisparo(TENANT, PNID, T0 + 120_000);

    const r = await reclamarDisparo(TENANT, PNID, T0 + 180_000);

    expect(r).toMatchObject({ ok: false, motivo: 'ya_disparado' });
    expect((r as { explicacion: string }).explicacion).toMatch(/una sola vez/i);
    expect((r as { explicacion: string }).explicacion).toMatch(/Embedded Signup/);
  });

  it('DOS reclamos CONCURRENTES: sólo uno dispara', async () => {
    await decidir('share');

    const [a, b] = await Promise.all([
      reclamarDisparo(TENANT, PNID, T0 + 120_000),
      reclamarDisparo(TENANT, PNID, T0 + 120_001),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('con la ventana vencida no se dispara, y el coordinador queda `expired`', async () => {
    await decidir('share');

    const r = await reclamarDisparo(TENANT, PNID, T0 + HISTORY_SYNC_WINDOW_MS + 1);

    expect(r).toMatchObject({ ok: false, motivo: 'vencido' });
    expect(docs.get(RUTA)!['status']).toBe('expired');
  });

  it('un disparo FALLIDO queda `failed` y dice que no hay reintento', async () => {
    await decidir('share');
    await reclamarDisparo(TENANT, PNID, T0 + 120_000);

    await registrarResultadoDelDisparo(TENANT, PNID, { ok: false, syncTypes: ['smb_app_state_sync'], error: 'graph_error_100' }, T0 + 130_000);

    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('failed');
    expect(coord!.errorMessage).toMatch(/no se puede reintentar/i);
    // Evidencia de hasta dónde llegó: la agenda sí se pidió, el historial no.
    expect(coord!.syncTypesRequested).toEqual(['smb_app_state_sync']);
    // Y desde `failed` tampoco se vuelve a disparar.
    expect(await reclamarDisparo(TENANT, PNID, T0 + 140_000)).toMatchObject({ ok: false, motivo: 'ya_disparado' });
  });
});

// ---------------------------------------------------------------------------
// Progreso: duplicados, reordenamientos y reintentos
// ---------------------------------------------------------------------------

describe('acumularObservaciones — idempotente ante duplicados, reorden y reintentos', () => {
  it('los chunks REORDENADOS dan el mismo resultado que en orden', () => {
    const enOrden = [obs({ chunkOrder: 1, progress: 30 }), obs({ chunkOrder: 2, progress: 70 }), obs({ chunkOrder: 3, progress: 100 })];
    const alReves = [...enOrden].reverse();

    const a = acumularObservaciones(null, enOrden);
    const b = acumularObservaciones(null, alReves);

    expect(a.status).toBe(b.status);
    expect(a.maxProgress).toBe(b.maxProgress);
    expect([...a.chunksObservados].sort()).toEqual([...b.chunksObservados].sort());
  });

  it('un chunk DUPLICADO no se cuenta dos veces', () => {
    const primero = acumularObservaciones(null, [obs({ chunkOrder: 1 })]);
    const segundo = acumularObservaciones(primero, [obs({ chunkOrder: 1, nuevo: false })]);

    expect(segundo.chunksObservadosCount).toBe(1);
    expect(segundo.chunksDuplicados).toBe(1);
  });

  it('llega al 100 % sin incidentes ⇒ `completed`', () => {
    const r = acumularObservaciones(null, [obs({ chunkOrder: 1, progress: 50 }), obs({ chunkOrder: 2, progress: 100 })]);
    expect(r.status).toBe('completed');
  });

  it('un chunk que NO se pudo persistir impide `completed` aunque el progreso llegue a 100', () => {
    const r = acumularObservaciones(null, [obs({ chunkOrder: 1, persistido: false }), obs({ chunkOrder: 2, progress: 100 })]);

    expect(r.status).toBe('failed');
    expect(r.chunksFallidosPendientes).toEqual(['p0c1']);
    expect(r.errorMessage).toMatch(/no se pudieron persistir/);
  });

  it('y cuando ESE chunk vuelve a llegar y se persiste, recién ahí es `completed`', () => {
    const previo = acumularObservaciones(null, [obs({ chunkOrder: 1, persistido: false }), obs({ chunkOrder: 2, progress: 100 })]);

    const r = acumularObservaciones(previo, [obs({ chunkOrder: 1, progress: 50, persistido: true, nuevo: true })]);

    expect(r.chunksFallidosPendientes).toEqual([]);
    expect(r.status).toBe('completed');
  });

  it('un chunk SIN tenant resuelto es pegajoso: nunca `completed`', () => {
    // Un chunk escrito sin empresa no se puede verificar mirando el dato, y el reintento llega
    // como duplicado: el documento ya existe. Declararlo completo sería declarar completo un
    // import parcial, que es exactamente el defecto auditado en `resolveTenantsDelArchivo`.
    const r = acumularObservaciones(null, [obs({ chunkOrder: 1, tenantResuelto: false }), obs({ chunkOrder: 2, progress: 100 })]);

    expect(r.status).toBe('failed');
    expect(r.chunksSinTenant).toBe(1);
    expect(r.errorMessage).toMatch(/empresa/);
  });

  it('«no compartió» (2593109) es un desenlace explícito y gana sobre todo lo demás', () => {
    const r = acumularObservaciones(null, [obs({ declinado: true, declineCode: 2593109, progress: null })]);

    expect(r.status).toBe('declined');
    expect(r.declineCode).toBe(2593109);
    expect(esEstadoTerminal(r.status)).toBe(true);
  });

  it('un chunk sin fase ni orden se cuenta pero declara la imprecisión', () => {
    const r = acumularObservaciones(null, [obs({ phase: null, chunkOrder: null, progress: 100 })]);

    expect(chunkKey(null, null)).toBeNull();
    expect(r.observadosTruncado).toBe(true);
    expect(r.chunksObservadosCount).toBe(1);
  });

  it('mientras falta progreso, el estado es `receiving`', () => {
    expect(acumularObservaciones(null, [obs({ progress: 40 })]).status).toBe('receiving');
  });
});

// ---------------------------------------------------------------------------
// Persistencia del progreso + vencimiento
// ---------------------------------------------------------------------------

describe('registrarObservaciones — progreso DURABLE', () => {
  it('persiste el avance y deja el coordinador en `receiving`', async () => {
    await decidir('share');
    await reclamarDisparo(TENANT, PNID, T0 + 120_000);

    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: [obs({ chunkOrder: 1, progress: 40 })], nowMs: T0 + 130_000 });

    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('receiving');
    expect(coord!.maxProgress).toBe(40);
    expect(coord!.chunksObservados).toEqual(['p0c1']);
  });

  it('reprocesar la MISMA tanda no mueve los contadores de material', async () => {
    await decidir('share');
    await reclamarDisparo(TENANT, PNID, T0 + 120_000);
    const tanda = [obs({ chunkOrder: 1, progress: 40 }), obs({ chunkOrder: 2, progress: 80 })];

    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: tanda, nowMs: T0 + 130_000 });
    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: tanda.map((o) => ({ ...o, nuevo: false })), nowMs: T0 + 140_000 });

    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.chunksObservadosCount).toBe(2);
    expect(coord!.chunksDuplicados).toBe(2);
  });

  it('el historial que llega DESPUÉS del deadline deja el coordinador `expired`', async () => {
    await decidir('share');
    await reclamarDisparo(TENANT, PNID, T0 + 120_000);

    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: [obs({ progress: 40 })], nowMs: T0 + HISTORY_SYNC_WINDOW_MS + 1 });

    expect((await leerCoordinador(TENANT, PNID))!.status).toBe('expired');
  });

  it('historial SIN coordinador previo: se guarda la evidencia en vez de perderla', async () => {
    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: [obs({ progress: 10 })], nowMs: T0 });

    const coord = await leerCoordinador(TENANT, PNID);
    expect(coord!.status).toBe('receiving');
    expect(coord!.errorMessage).toMatch(/sin coordinador/i);
    // Y un coordinador nacido así NUNCA habilita un disparo.
    expect(puedeDisparar(coord, T0)).toMatchObject({ puede: false, motivo: 'sin_decision' });
  });

  it('el conteo de adjuntos del historial se acumula aparte', async () => {
    await decidir('share');
    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: [], mediaObservados: 3, nowMs: T0 });
    await registrarObservaciones({ tenantId: TENANT, phoneNumberId: PNID, observaciones: [], mediaObservados: 2, nowMs: T0 + 1 });

    expect((await leerCoordinador(TENANT, PNID))!.mediaObservados).toBe(5);
  });
});

describe('vencido — la ventana corre desde el onboarding', () => {
  it('un estado terminal no vence', () => {
    expect(vencido({ status: 'completed', deadlineAt: ts(T0) as never }, T0 + 10)).toBe(false);
  });
  it('sin deadline no se puede afirmar vencimiento', () => {
    expect(vencido({ status: 'receiving', deadlineAt: null }, T0 + 10)).toBe(false);
  });
  it('con deadline pasado, sí', () => {
    expect(vencido({ status: 'receiving', deadlineAt: ts(T0) as never }, T0 + 1)).toBe(true);
  });
});
