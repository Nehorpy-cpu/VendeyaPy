/**
 * historyCoordinator.fencing.test.ts — el fencing generacional del coordinador (H6 / H8 / H9)
 * ============================================================================================
 * Cierre correctivo sobre ADR-0017 §5/§6. Tres agujeros de la misma familia: el estado vigente del
 * coordinador se usaba como sustituto de la IDENTIDAD del ciclo que originó cada escritura.
 *
 *  · H6 — el offboarding retornaba temprano sobre un estado terminal, pero un `failed` POR
 *    PERSISTENCIA (sin `cierreAdministrativo`) es recuperable POR DISEÑO: material tardío lo
 *    reabría a `receiving`/`completed` DESPUÉS del offboarding. El offboarding tiene que SELLAR
 *    cualquier estado no sellado, conservando el desenlace si ya era terminal.
 *  · H8 — el settlement del disparo hacía merge ciego sobre el documento vigente: una respuesta
 *    tardía de Graph del ciclo N podía cerrar o fallar la generación N+1.
 *  · H9 — un chunk reentregado de la generación N llegaba etiquetado (el webhook selló la
 *    generación al persistirlo) pero el coordinador lo acumulaba sobre la vigente: material de
 *    OTRO ciclo gobernaba el desenlace del nuevo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();
const versiones = new Map<string, number>();

interface Op { path: string; data: Record<string, unknown>; merge?: boolean }

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

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
        if (chocó) continue;
        for (const op of ops) {
          docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data } : { ...op.data });
          versiones.set(op.path, (versiones.get(op.path) ?? 0) + 1);
        }
        return r;
      }
      throw new Error('transacción sin converger');
    },
  }),
  paths: {},
}));

import {
  abrirNuevaGeneracion,
  cerrarGeneracionPorOffboarding,
  coexistenceHistorySyncPath,
  reclamarDisparo,
  registrarDecisionDeHistorial,
  registrarObservaciones,
  registrarResultadoDelDisparo,
  type ChunkObservado,
  type HistorySyncDoc,
} from './historyCoordinator.js';
import { logger } from '../lib/logger.js';

const T = 'tnt_fencing';
const PNID = '900000777';
const VIGENTE = coexistenceHistorySyncPath(T, PNID);
const NOW = 1_754_300_000_000;

const coordinador = () => docs.get(VIGENTE) as HistorySyncDoc | undefined;

const chunk = (over: Partial<ChunkObservado> = {}): ChunkObservado => ({
  phase: 0, chunkOrder: 1, progress: 100, nuevo: true, persistido: true, tenantResuelto: true, declinado: false, ...over,
});

const decidir = (decision: 'share' | 'skip', nowMs = NOW) =>
  registrarDecisionDeHistorial({
    tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
    decision, actorUid: 'uid-owner', onboardedAtMs: NOW - 3_600_000, nowMs,
  });

beforeEach(() => { docs.clear(); versiones.clear(); vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// H6 — el offboarding sella TODO estado no sellado
// ---------------------------------------------------------------------------

describe('H6 — un `failed` previo no sellado no puede reabrirse tras el offboarding', () => {
  it('el `failed` por persistencia queda SELLADO por el offboarding: el chunk que vuelve ya no lo reabre', async () => {
    // Gen 1 disparada; un chunk llega al 100 % pero su persistencia FALLA ⇒ `failed` recuperable
    // por diseño (sin sello): si ese chunk volviera ANTES del offboarding, el import cerraría bien.
    await decidir('share');
    await reclamarDisparo(T, PNID, NOW + 1000);
    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 2000,
      observaciones: [chunk({ persistido: false })],
    });
    expect(coordinador()?.status).toBe('failed');
    expect(coordinador()?.cierreAdministrativo).toBe(false); // precondición: recuperable

    // Meta offboardea el número. Desde acá, «recuperable» dejó de ser verdad: no hay ciclo vivo.
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 3000);

    // El chunk faltante llega TARDE (reentrega de Meta), ahora sí persistido.
    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 4000,
      observaciones: [chunk({ persistido: true })],
    });

    const c = coordinador();
    // El defecto contra 2798296: esto quedaba `completed` — la generación offboardeada RESUCITABA.
    expect(c?.status).toBe('failed');
    expect(c?.cierreAdministrativo).toBe(true);
    expect(c?.chunksFueraDeCiclo).toBe(1);
  });

  it('un desenlace terminal (`declined`) conserva su contenido y SOLO gana el sello', async () => {
    await decidir('skip');
    const antes = { ...coordinador()! };

    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);

    const sellado = coordinador();
    // Cerrar no es decidir: el desenlace y su motivo quedan EXACTAMENTE como estaban…
    expect(sellado).toMatchObject({ status: antes.status, errorMessage: antes.errorMessage, sharingDecision: 'skip' });
    // …pero el sello queda puesto: contra 2798296 el retorno temprano no lo escribía.
    expect(sellado?.cierreAdministrativo).toBe(true);

    // Y material tardío ya no toca ni los contadores del desenlace: es de OTRO ciclo.
    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 2000,
      observaciones: [chunk()],
    });
    const c = coordinador();
    expect(c?.status).toBe('declined');
    expect(c?.chunksObservadosCount ?? 0).toBe(0);
    expect(c?.chunksFueraDeCiclo).toBe(1);
  });

  it('el reintento del offboarding es idempotente: la segunda pasada no toca nada', async () => {
    await decidir('share');
    await reclamarDisparo(T, PNID, NOW + 1000);
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 2000);
    const primeraPasada = { ...coordinador()! };
    const versionAntes = versiones.get(VIGENTE);

    // Meta reentrega el `account_update`: el sello ya está puesto y no hay nada más que escribir.
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 3000);

    expect(coordinador()).toEqual(primeraPasada);
    expect(versiones.get(VIGENTE)).toBe(versionAntes);
  });
});

// ---------------------------------------------------------------------------
// H8 — el settlement exige la generación reclamada (unidad, sin el flujo de smbAppData)
// ---------------------------------------------------------------------------

describe('H8 — registrarResultadoDelDisparo está cercado por la generación reclamada', () => {
  it('un settlement de una generación superada NO escribe, y deja rastro observable', async () => {
    await decidir('share');
    await reclamarDisparo(T, PNID, NOW + 1000);
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 2000);
    await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + 3000, nowMs: NOW + 3000 });
    const gen2Antes = { ...coordinador()! };

    // El desenlace del disparo de la gen 1 llega DESPUÉS de que la gen 2 abrió.
    await registrarResultadoDelDisparo(T, PNID, 1, { ok: false, syncTypes: ['smb_app_state_sync'], error: 'graph_error_100' }, NOW + 4000);

    expect(coordinador()).toEqual(gen2Antes);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/generación superada/),
      expect.objectContaining({ generacionReclamada: 1, generacionVigente: 2 }),
    );
  });

  it('el settlement de la generación VIGENTE escribe igual que siempre', async () => {
    await decidir('share');
    await reclamarDisparo(T, PNID, NOW + 1000);

    await registrarResultadoDelDisparo(T, PNID, 1, { ok: true, syncTypes: ['smb_app_state_sync', 'history'] }, NOW + 2000);

    expect(coordinador()).toMatchObject({ status: 'requested', syncTypesRequested: ['smb_app_state_sync', 'history'] });
  });
});

// ---------------------------------------------------------------------------
// H9 — material etiquetado con OTRA generación no gobierna la vigente
// ---------------------------------------------------------------------------

describe('H9 — un chunk etiquetado con la generación N no gobierna la generación N+1', () => {
  /** Deja la gen 1 cerrada por offboarding y la gen 2 decidida `share` y DISPARADA (receptora). */
  async function generacionDosDisparada(): Promise<void> {
    await decidir('share');
    await reclamarDisparo(T, PNID, NOW + 1000);
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 2000);
    await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + 3000, nowMs: NOW + 3000 });
    await registrarDecisionDeHistorial({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, decision: 'share', actorUid: 'uid-owner', onboardedAtMs: NOW + 3000, nowMs: NOW + 4000 });
    await reclamarDisparo(T, PNID, NOW + 5000);
    expect(coordinador()).toMatchObject({ syncGeneration: 2, status: 'requested' });
  }

  it('la reentrega tardía de la gen 1 (etiquetada) cuenta como fuera de ciclo, no como progreso de la 2', async () => {
    await generacionDosDisparada();

    // El webhook persistió este chunk bajo la generación 1 (su clave lo dice) y lo declara acá.
    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 6000,
      observaciones: [chunk({ chunkOrder: 9 })],
      generacionEtiquetada: 1,
    });

    const c = coordinador();
    expect(c?.syncGeneration).toBe(2);
    // El defecto contra 2798296: el chunk al 100 % de la gen 1 dejaba la gen 2 `completed` sin
    // haber recibido UN solo chunk propio — y su import real moriría como «ya completado».
    expect(c?.status).toBe('requested');
    expect(c?.chunksObservadosCount).toBe(0);
    expect(c?.chunksFueraDeCiclo).toBe(1);
  });

  it('la etiqueta que COINCIDE con la vigente gobierna normal (el fencing no frena el ciclo sano)', async () => {
    await generacionDosDisparada();

    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 6000,
      observaciones: [chunk({ chunkOrder: 3, progress: 40 })],
      generacionEtiquetada: 2,
    });

    expect(coordinador()).toMatchObject({ status: 'receiving', chunksObservadosCount: 1, maxProgress: 40 });
  });

  it('sin etiqueta, el comportamiento es el de siempre (retrocompatible con el webhook actual)', async () => {
    await generacionDosDisparada();

    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 6000,
      observaciones: [chunk({ chunkOrder: 3, progress: 40 })],
    });

    expect(coordinador()).toMatchObject({ status: 'receiving', chunksObservadosCount: 1 });
  });
});
