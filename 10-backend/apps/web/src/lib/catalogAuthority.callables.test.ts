/**
 * catalogAuthority.callables.test.ts — los wrappers llaman al callable CORRECTO con el
 * payload EXACTO del contrato ADR-0022. El backend se implementa en paralelo: estos tests
 * fijan los nombres (`metaCatalogAuthorityPreview` / `metaCatalogAuthorityApply`) para que
 * el panel y las functions no se desincronicen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { httpsCallableMock, llamadas, respuesta } = vi.hoisted(() => {
  const llamadas: { name: string; payload: unknown }[] = [];
  const respuesta: { data: unknown } = { data: { ok: true } };
  const httpsCallableMock = vi.fn((_fns: unknown, name: string) => (payload: unknown) => {
    llamadas.push({ name, payload });
    return Promise.resolve({ data: respuesta.data });
  });
  return { httpsCallableMock, llamadas, respuesta };
});

vi.mock('firebase/functions', () => ({ httpsCallable: httpsCallableMock }));
vi.mock('./firebase', () => ({ firebaseDb: () => ({}), firebaseFunctions: () => ({}) }));

import { applyCatalogAuthority, fetchCatalogAuthorityPreview } from './catalogAuthority';

beforeEach(() => {
  llamadas.length = 0;
  respuesta.data = { ok: true };
});

const ultima = () => llamadas[llamadas.length - 1]!;

describe('metaCatalogAuthorityPreview', () => {
  it('recibe {tenantId, target:{authority, relationship}} y normaliza la respuesta', async () => {
    respuesta.data = {
      ok: true,
      resumen: 'Pasa a espejo.',
      bloqueos: [],
      advertencias: [],
      estadoEsperado: { authority: 'meta', relationship: 'mirror' },
      planHash: 'ph-9',
      runId: 'run-9',
      expiresAt: 1_800_000_600_000,
    };
    const p = await fetchCatalogAuthorityPreview('perfumeria', { authority: 'meta', relationship: 'mirror' });
    expect(ultima()).toEqual({
      name: 'metaCatalogAuthorityPreview',
      payload: { tenantId: 'perfumeria', target: { authority: 'meta', relationship: 'mirror' } },
    });
    expect(p.planHash).toBe('ph-9');
    expect(p.runId).toBe('run-9');
    expect(p.estadoEsperado).toEqual({ authority: 'meta', relationship: 'mirror' });
  });

  it('con bloqueos la vista queda sin planHash (fail-closed)', async () => {
    respuesta.data = { ok: false, bloqueos: [{ id: 'connection_missing' }], planHash: 'colado' };
    const p = await fetchCatalogAuthorityPreview('perfumeria', { authority: 'vendeyapy', relationship: 'managed' });
    expect(p.planHash).toBeNull();
    expect(p.bloqueos[0]!.id).toBe('connection_missing');
  });
});

describe('metaCatalogAuthorityApply', () => {
  it('recibe {tenantId, runId, planHash} y devuelve antes/después tipados', async () => {
    respuesta.data = {
      ok: true,
      antes: { authority: 'vendeyapy', relationship: 'managed' },
      despues: { authority: 'vendeyapy', relationship: 'none' },
    };
    const r = await applyCatalogAuthority('perfumeria', 'run-9', 'ph-9');
    expect(ultima()).toEqual({
      name: 'metaCatalogAuthorityApply',
      payload: { tenantId: 'perfumeria', runId: 'run-9', planHash: 'ph-9' },
    });
    expect(r.ok).toBe(true);
    expect(r.antes).toEqual({ authority: 'vendeyapy', relationship: 'managed' });
    expect(r.despues).toEqual({ authority: 'vendeyapy', relationship: 'none' });
  });

  it('respuesta rota ⇒ ok:false y estados null (nada se inventa)', async () => {
    respuesta.data = { ok: true, antes: 'raro', despues: { authority: 'x', relationship: 'mirror' } };
    const r = await applyCatalogAuthority('perfumeria', 'r', 'p');
    expect(r.antes).toBeNull();
    expect(r.despues).toBeNull();
  });
});
