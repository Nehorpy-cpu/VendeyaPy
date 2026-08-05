/**
 * historyCoordinator.generaciones.test.ts — re-onboarding sin perder la historia
 * ==============================================================================
 * CORRECTIVO ADR-0017 §5/§6. La regla oficial es dura: la sincronización se pide UNA vez, y la
 * única recuperación real tras un mal desenlace es que el cliente offboardee el número y REHAGA el
 * Embedded Signup. El coordinador tenía la mitad de esa frase: los motivos `ya_disparado` y
 * `no_compartir` eran terminales… y no existía NINGÚN mecanismo que, tras el offboarding y el nuevo
 * signup, abriera un ciclo nuevo. La "recuperación" que el propio texto de rechazo prometía era
 * imposible: la decisión anterior bloqueaba para siempre una reconexión legítima.
 *
 * El ciclo que se prueba acá:
 *  · `ACCOUNT_OFFBOARDED` cierra la generación vigente de forma HONESTA (no inventa consentimiento,
 *    no borra nada) — y una generación ya terminal queda intacta.
 *  · Solo un onboarding AUTORIZADO (claim de code nuevo, consumido transaccionalmente) abre la
 *    generación siguiente: sin decisión heredada, contadores a cero, ventana nueva.
 *  · La generación anterior se ARCHIVA íntegra (auditoría), jamás se borra ni se reescribe.
 *  · Un replay del MISMO claim devuelve lo mismo sin abrir otra generación; un claim VIEJO
 *    (de una generación archivada) no puede resetear la nueva.
 *  · Dentro de una generación, el disparo sigue siendo único (eso ya estaba probado; acá se
 *    verifica que la generación nueva vuelve a tener EXACTAMENTE un disparo).
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
}));

import {
  coexistenceHistorySyncPath,
  archivoDeGeneracionPath,
  abrirNuevaGeneracion,
  conReintentos,
  cerrarGeneracionPorOffboarding,
  registrarDecisionDeHistorial,
  reclamarDisparo,
  registrarObservaciones,
  leerCoordinador,
  type HistorySyncDoc,
} from './historyCoordinator.js';

const T = 'tnt_gen';
const PNID = '555000111222';
const VIGENTE = coexistenceHistorySyncPath(T, PNID);
const NOW = 1_760_000_000_000;
const DIA = 24 * 3_600_000;

const coordinador = () => docs.get(VIGENTE) as HistorySyncDoc | undefined;

/** Deja una generación 1 decidida `share` y ya disparada (el estado típico pre-offboarding). */
async function generacionUnoDisparada(): Promise<void> {
  await registrarDecisionDeHistorial({
    tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
    decision: 'share', actorUid: 'owner1', onboardedAtMs: NOW - 3_600_000, nowMs: NOW,
  });
  const r = await reclamarDisparo(T, PNID, NOW);
  expect(r.ok).toBe(true);
}

beforeEach(() => {
  docs.clear();
  versiones.clear();
});

describe('offboarding — la generación vigente se cierra de forma honesta', () => {
  it('una generación NO terminal (requested) queda `failed` con el motivo, sin inventar consentimiento', async () => {
    await generacionUnoDisparada();

    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);

    const c = coordinador();
    expect(c?.status).toBe('failed');
    expect(c?.errorMessage).toMatch(/offboard/i);
    // La decisión que el humano tomó no se reescribe: cerrar no es decidir.
    expect(c?.sharingDecision).toBe('share');
  });

  it('una generación ya TERMINAL (declined) queda intacta', async () => {
    await registrarDecisionDeHistorial({
      tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      decision: 'skip', actorUid: 'owner1', onboardedAtMs: NOW - 3_600_000, nowMs: NOW,
    });
    const antes = { ...coordinador()! };

    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);

    expect(coordinador()).toMatchObject({ status: antes.status, errorMessage: antes.errorMessage });
  });

  it('sin coordinador no inventa uno', async () => {
    await cerrarGeneracionPorOffboarding(T, PNID, NOW);
    expect(docs.has(VIGENTE)).toBe(false);
  });
});

describe('re-onboarding — solo un claim nuevo abre la generación siguiente', () => {
  it('sobre una generación terminal: archiva la 1 INTACTA y abre la 2 sin decisión heredada', async () => {
    await generacionUnoDisparada();
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);
    const gen1 = { ...coordinador()! };

    const r = await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });

    expect(r).toMatchObject({ ok: true, syncGeneration: 2, reused: false });
    // El archivo conserva la generación 1 byte a byte (auditoría: jamás se borra).
    expect(docs.get(archivoDeGeneracionPath(T, PNID, 1))).toMatchObject({
      status: gen1.status, sharingDecision: gen1.sharingDecision, syncGeneration: 1,
    });
    // La vigente es la 2: sin decisión (no se hereda consentimiento), contadores a cero, ventana nueva.
    const c = coordinador();
    expect(c).toMatchObject({ syncGeneration: 2, sharingDecision: null, chunksObservadosCount: 0, chunksDuplicados: 0 });
    expect(c?.deadlineAt?.toMillis()).toBe(NOW + DIA + DIA);
  });

  it('la decisión `skip` anterior NO bloquea la generación nueva: se puede volver a decidir', async () => {
    await registrarDecisionDeHistorial({
      tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      decision: 'skip', actorUid: 'owner1', onboardedAtMs: NOW - 3_600_000, nowMs: NOW,
    });
    await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });

    const r = await registrarDecisionDeHistorial({
      tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      decision: 'share', actorUid: 'owner1', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA + 1000,
    });

    expect(r.ok).toBe(true);
    // Y el disparo único vuelve a existir EXACTAMENTE una vez en la generación nueva.
    expect((await reclamarDisparo(T, PNID, NOW + DIA + 2000)).ok).toBe(true);
    expect((await reclamarDisparo(T, PNID, NOW + DIA + 3000)).ok).toBe(false);
  });

  it('una sincronización FALLIDA anterior tampoco bloquea el ciclo nuevo', async () => {
    await generacionUnoDisparada();
    docs.set(VIGENTE, { ...docs.get(VIGENTE)!, status: 'failed', errorMessage: 'el disparo falló' });

    const r = await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });

    expect(r).toMatchObject({ ok: true, syncGeneration: 2 });
  });

  it('REPLAY del mismo claim: mismo resultado, sin tercera generación ni archivo duplicado', async () => {
    await generacionUnoDisparada();
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);
    const r1 = await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });
    const r2 = await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA + 5000 });

    expect(r1).toMatchObject({ ok: true, syncGeneration: 2, reused: false });
    expect(r2).toMatchObject({ ok: true, syncGeneration: 2, reused: true });
    expect(docs.has(archivoDeGeneracionPath(T, PNID, 2))).toBe(false);
  });

  it('un claim VIEJO (de una generación archivada) no resetea la vigente', async () => {
    await generacionUnoDisparada();
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);
    await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + DIA + 1000);
    await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_C', onboardedAtMs: NOW + 2 * DIA, nowMs: NOW + 2 * DIA });
    const vigenteAntes = { ...coordinador()! };

    // El callback de la generación 2 llega tarde (reentrega vieja): NO puede tocar la 3.
    const r = await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + 2 * DIA + 5000 });

    expect(r.ok).toBe(false);
    expect(coordinador()).toMatchObject({ syncGeneration: vigenteAntes.syncGeneration, sharingDecision: vigenteAntes.sharingDecision });
  });

  it('si la vigente NO es terminal y llega un claim nuevo (offboard que nunca avisó), la cierra honesta y abre igual', async () => {
    await generacionUnoDisparada();

    const r = await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });

    expect(r).toMatchObject({ ok: true, syncGeneration: 2 });
    const archivada = docs.get(archivoDeGeneracionPath(T, PNID, 1)) as HistorySyncDoc;
    expect(archivada.status).toBe('failed');
    expect(archivada.errorMessage).toMatch(/nuevo onboarding/i);
  });
});

describe('la decisión NO fabrica generaciones', () => {
  it('decidir sobre un coordinador nacido del webhook (huérfano) conserva su generación', async () => {
    docs.set(VIGENTE, {
      id: PNID, tenantId: T, phoneNumberId: PNID, connectionId: '', status: 'receiving',
      syncGeneration: 1, sharingDecision: null, chunksObservados: [], chunksObservadosCount: 3,
    });

    const r = await registrarDecisionDeHistorial({
      tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`,
      decision: 'share', actorUid: 'owner1', onboardedAtMs: NOW - 3_600_000, nowMs: NOW,
    });

    // El defecto era `(previo?.syncGeneration ?? 0) + 1`: decidir subía la generación sin que
    // hubiera existido ningún segundo onboarding, y partía la clave de idempotencia del webhook.
    expect(r).toMatchObject({ ok: true, syncGeneration: 1 });
    expect((await leerCoordinador(T, PNID))?.syncGeneration).toBe(1);
  });
});

describe('chunks fuera de ciclo — el material tardío no gobierna la generación nueva (correctivo, ALTO 10 / MEDIO 18)', () => {
  it('un chunk que llega con la generación en `pending_request` (sin disparo) NO la mueve a `receiving`', async () => {
    // Gen 2 recién abierta y decidida `share`, disparo TODAVÍA no usado. Llega material tardío de
    // la gen 1 (Meta reentrega): si moviera el estado, `puedeDisparar` diría «ya_disparado» y el
    // único disparo de la generación nueva se quemaría sin haberse usado.
    await generacionUnoDisparada();
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);
    await abrirNuevaGeneracion({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, claimId: 'claim_B', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA });
    await registrarDecisionDeHistorial({ tenantId: T, phoneNumberId: PNID, connectionId: `wa_${PNID}`, decision: 'share', actorUid: 'owner1', onboardedAtMs: NOW + DIA, nowMs: NOW + DIA + 1000 });

    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + DIA + 2000,
      observaciones: [{ phase: 0, chunkOrder: 1, progress: 50, nuevo: true, persistido: true, tenantResuelto: true, declinado: false }],
    });

    const c = coordinador();
    expect(c?.status).toBe('pending_request');
    // Y el disparo único sigue disponible: el material tardío no lo quemó.
    expect((await reclamarDisparo(T, PNID, NOW + DIA + 3000)).ok).toBe(true);
  });

  it('el `failed` del cierre ADMINISTRATIVO es pegajoso: chunks tardíos no lo reabren', async () => {
    await generacionUnoDisparada();
    await cerrarGeneracionPorOffboarding(T, PNID, NOW + 1000);

    await registrarObservaciones({
      tenantId: T, phoneNumberId: PNID, nowMs: NOW + 2000,
      observaciones: [{ phase: 0, chunkOrder: 7, progress: 100, nuevo: true, persistido: true, tenantResuelto: true, declinado: false }],
    });

    const c = coordinador();
    // Reabrirla a `receiving`/`completed` borraría el motivo por el que alguien tiene que mirar.
    expect(c?.status).toBe('failed');
    expect(c?.errorMessage).toMatch(/offboard/i);
  });
});

describe('conReintentos — la ventana claim→generación tiene red (correctivo, MEDIOs 15/19)', () => {
  it('dos fallos transitorios y el tercero sale: el resultado llega', async () => {
    let intentos = 0;
    const r = await conReintentos(async () => {
      intentos++;
      if (intentos < 3) throw new Error('transitorio');
      return 'ok';
    }, 3);

    expect(r).toBe('ok');
    expect(intentos).toBe(3);
  });

  it('agotados los intentos, lanza el último error (el diagnóstico no se traga)', async () => {
    let intentos = 0;
    await expect(
      conReintentos(async () => {
        intentos++;
        throw new Error(`fallo ${intentos}`);
      }, 3),
    ).rejects.toThrow('fallo 3');
    expect(intentos).toBe(3);
  });

  it('el primer intento exitoso no reintenta nada', async () => {
    let intentos = 0;
    await conReintentos(async () => { intentos++; return 1; }, 3);
    expect(intentos).toBe(1);
  });
});
