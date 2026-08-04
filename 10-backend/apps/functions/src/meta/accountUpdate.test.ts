/**
 * accountUpdate.test.ts — el ciclo de desconexión de Coexistence (ADR-0017 §6)
 * =============================================================================
 * Meta desconecta el número por su cuenta y lo avisa por `account_update`. Sin consumirlo, un
 * número en `live` automatiza contra una conexión muerta. Lo que custodia este test:
 *
 *  · `ACCOUNT_OFFBOARDED` / `PARTNER_REMOVED` degradan ESE PNID a `inactive`, en el asset Y en el
 *    índice (el desempate es por el más restrictivo);
 *  · `ACCOUNT_RECONNECTED` NO re-otorga permiso solo;
 *  · nada más se toca: `status`, `selected`, `connectionId`, el token y el ruteo quedan intactos,
 *    porque revertir esto tiene que ser la escritura de UN campo por un humano;
 *  · sin `phone_number_id` no se degrada a NADIE: silenciar el número equivocado es el desenlace
 *    prohibido, y es peor que enterarse tarde de una desconexión.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const auditorias: Array<Record<string, unknown>> = [];
vi.mock('../audit/audit.js', () => ({ recordAudit: async (e: Record<string, unknown>) => { auditorias.push(e); } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
      },
    }),
    batch: () => {
      const ops: Array<{ path: string; data: Record<string, unknown>; merge?: boolean }> = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ path: ref.path, data, merge: opts?.merge }),
        commit: async () => { for (const o of ops) docs.set(o.path, o.merge ? { ...(docs.get(o.path) ?? {}), ...o.data } : { ...o.data }); },
      };
    },
  }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

import { aplicarAccountUpdate, degradaPermiso } from './accountUpdate.js';
import type { NormalizedAccountUpdate } from './parseWebhook.js';

const TENANT = 'tnt_alpha';
const PNID = '900000002';
const T0 = 1_754_200_000_000;
const assetPath = `tenants/${TENANT}/metaAssets/${PNID}`;
const idxPath = `metaExternalIndex/whatsapp_${PNID}`;

const evento = (event: NormalizedAccountUpdate['event'], externalId = PNID): NormalizedAccountUpdate => ({
  platform: 'whatsapp', externalId, wabaId: 'WABA_ID', event, rawEvent: event, timestamp: T0 / 1000,
});

const sembrar = (over: Record<string, unknown> = {}): void => {
  docs.set(assetPath, {
    id: PNID, tenantId: TENANT, connectionId: `wa_${PNID}`, assetType: 'whatsapp_phone_number',
    externalId: PNID, status: 'active', selected: false, automationMode: 'live', sessionKey: `wa_${PNID}`, ...over,
  });
  docs.set(idxPath, { id: `whatsapp_${PNID}`, tenantId: TENANT, connectionId: `wa_${PNID}`, externalId: PNID, status: 'active' });
};

beforeEach(() => { docs.clear(); auditorias.length = 0; vi.clearAllMocks(); });

describe('degradaPermiso — vocabulario cerrado', () => {
  it('sólo las desconexiones', () => {
    expect(degradaPermiso('ACCOUNT_OFFBOARDED')).toBe(true);
    expect(degradaPermiso('PARTNER_REMOVED')).toBe(true);
    expect(degradaPermiso('ACCOUNT_RECONNECTED')).toBe(false);
    expect(degradaPermiso('unknown')).toBe(false);
  });
});

describe('ACCOUNT_OFFBOARDED / PARTNER_REMOVED — el número deja de automatizar', () => {
  it('degrada el asset a `inactive`', async () => {
    sembrar();

    const r = await aplicarAccountUpdate(evento('ACCOUNT_OFFBOARDED'), T0);

    expect(r).toEqual({ aplicado: true, accion: 'degradado', tenantId: TENANT });
    expect(docs.get(assetPath)!['automationMode']).toBe('inactive');
  });

  it('y también el índice: el desempate es por el más restrictivo', async () => {
    sembrar();

    await aplicarAccountUpdate(evento('PARTNER_REMOVED'), T0);

    expect(docs.get(idxPath)!['automationMode']).toBe('inactive');
  });

  it('NO toca nada más: status, selected, connectionId, sessionKey ni el ruteo', async () => {
    sembrar();

    await aplicarAccountUpdate(evento('ACCOUNT_OFFBOARDED'), T0);

    const asset = docs.get(assetPath)!;
    expect(asset['status']).toBe('active');
    expect(asset['selected']).toBe(false);
    expect(asset['connectionId']).toBe(`wa_${PNID}`);
    expect(asset['sessionKey']).toBe(`wa_${PNID}`);
    expect(docs.get(idxPath)!['connectionId']).toBe(`wa_${PNID}`);
    expect(docs.has(idxPath)).toBe(true);
  });

  it('deja rastro auditable del origen (Meta, no un administrador)', async () => {
    sembrar();

    await aplicarAccountUpdate(evento('ACCOUNT_OFFBOARDED'), T0);

    expect(auditorias).toHaveLength(1);
    expect(auditorias[0]).toMatchObject({ tenantId: TENANT, actorUid: null, metadata: { source: 'account_update', event: 'ACCOUNT_OFFBOARDED' } });
  });
});

describe('ACCOUNT_RECONNECTED — reconectar no es autorizar', () => {
  it('el número vuelve SIN permiso de automatización', async () => {
    sembrar();

    const r = await aplicarAccountUpdate(evento('ACCOUNT_RECONNECTED'), T0);

    expect(r).toEqual({ aplicado: true, accion: 'reconectado_sin_permiso', tenantId: TENANT });
    expect(docs.get(assetPath)!['automationMode']).toBe('inactive');
  });
});

describe('lo que NO se hace', () => {
  it('sin phone_number_id no se degrada a nadie', async () => {
    sembrar();

    const r = await aplicarAccountUpdate(evento('ACCOUNT_OFFBOARDED', ''), T0);

    expect(r).toEqual({ aplicado: false, motivo: 'sin_pnid' });
    expect(docs.get(assetPath)!['automationMode']).toBe('live');
    expect(auditorias).toEqual([]);
  });

  it('un evento desconocido no ejecuta nada', async () => {
    sembrar();

    const r = await aplicarAccountUpdate({ ...evento('ACCOUNT_OFFBOARDED'), event: 'unknown', rawEvent: 'ALGO_NUEVO' }, T0);

    expect(r).toEqual({ aplicado: false, motivo: 'evento_desconocido' });
    expect(docs.get(assetPath)!['automationMode']).toBe('live');
  });

  it('si el número no resuelve a ninguna empresa, no se escribe nada', async () => {
    const r = await aplicarAccountUpdate(evento('ACCOUNT_OFFBOARDED'), T0);

    expect(r).toEqual({ aplicado: false, motivo: 'sin_tenant' });
    expect(docs.size).toBe(0);
  });

  it('si el índice apunta a una empresa pero no hay asset, tampoco', async () => {
    docs.set(idxPath, { tenantId: TENANT, connectionId: `wa_${PNID}` });

    const r = await aplicarAccountUpdate(evento('ACCOUNT_OFFBOARDED'), T0);

    expect(r).toEqual({ aplicado: false, motivo: 'sin_asset' });
    expect(docs.get(idxPath)).not.toHaveProperty('automationMode');
  });
});
