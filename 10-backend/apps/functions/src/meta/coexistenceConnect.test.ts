/**
 * coexistenceConnect.test.ts — ETAPA C: conectar el número real SIN rozar `main`
 * ==============================================================================
 * Lo que este test custodia, en orden de gravedad:
 *
 *  1. El número principal —el que vende AHORA— sale de acá exactamente como entró: su conexión,
 *     su token, su `selected`, su `automationMode` y su entrada de índice.
 *  2. El número nuevo nace MUDO: sin `automationMode` (que por fail-closed es `inactive`),
 *     `selected: false`, y con su propia `sessionKey`.
 *  3. El PNID se resuelve SERVER-SIDE (`GET /<WABA_ID>/phone_numbers`), nunca desde el
 *     `postMessage` — y si el WABA lista varios números, el flujo NO adivina.
 *  4. Un replay del callback devuelve lo mismo: ni otra conexión ni otro secreto.
 *  5. Un fallo parcial no deja una conexión que parezca activa ni un secreto huérfano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();

interface Op { tipo: 'set' | 'delete'; path: string; data?: Record<string, unknown>; merge?: boolean }

const aplicar = (ops: Op[]): void => {
  for (const op of ops) {
    if (op.tipo === 'delete') docs.delete(op.path);
    else docs.set(op.path, op.merge ? { ...(docs.get(op.path) ?? {}), ...op.data! } : op.data!);
  }
};

const hijosDe = (col: string) =>
  [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, v]) => ({ id: k.split('/').pop()!, ref: { path: k }, data: () => v }));

const consulta = (path: string, filtro?: { campo: string; valor: unknown }): Record<string, unknown> => ({
  __coleccion: path,
  __filtro: filtro,
  get: async () => ({ docs: hijosDe(path).filter((d) => !filtro || (d.data() as Record<string, unknown>)[filtro.campo] === filtro.valor) }),
  where: (campo: string, _op: string, valor: unknown) => consulta(path, { campo, valor }),
});

const leer = async (ref: { path?: string; __coleccion?: string }) => {
  if (ref.__coleccion) return { docs: hijosDe(ref.__coleccion) };
  const path = ref.path!;
  return { exists: docs.has(path), data: () => docs.get(path) };
};

/** `fallaAlEscribir` reproduce un fallo de persistencia DESPUÉS de haber guardado el secreto. */
let fallaAlEscribir = false;

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : { ...data });
      },
    }),
    collection: (path: string) => consulta(path),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const ops: Op[] = [];
      const tx = {
        get: leer,
        set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => ops.push({ tipo: 'set', path: ref.path, data, merge: opts?.merge }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      if (fallaAlEscribir) throw new Error('firestore caído');
      aplicar(ops);
      return r;
    },
  }),
  paths: {
    metaAssets: (t: string) => `tenants/${t}/metaAssets`,
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}`,
    metaExternalIndex: () => 'metaExternalIndex',
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

const secretos = new Map<string, string>();
vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({
    set: async (n: string, v: string) => { secretos.set(`secret://${n}`, v); return `secret://${n}`; },
    get: async (r: string) => secretos.get(r) ?? null,
    remove: async (r: string) => { secretos.delete(r); },
  }),
}));

import { runCoexistenceConnect, elegirNumeroDeCoexistencia, elegirWabaDeCoexistencia } from './coexistenceConnect.js';
import type { AddNumberDeps } from './multiNumber.js';
import type { MetaGraphClient, MetaPhoneNumber } from './graphClient.js';

const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID_PRINCIPAL = '900000001';
const PNID_NUEVO = '900000002';
const WABA = 'waba-1';
const SECRETO_PRINCIPAL = 'secret://meta-token-tnt_alpha';

const assetPath = (id: string) => `tenants/${TENANT}/metaAssets/${id}`;
const connPath = (id: string) => `tenants/${TENANT}/metaConnections/${id}`;
const idxPath = (id: string) => `metaExternalIndex/whatsapp_${id}`;

const numero = (id: string): MetaPhoneNumber => ({
  id, displayPhoneNumber: 'numero-de-prueba', verifiedName: 'Perfumería', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED',
});

const graph = (over: Partial<MetaGraphClient> = {}): MetaGraphClient => ({
  exchangeCode: async () => ({ accessToken: 'token-del-signup', tokenType: 'bearer', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], wabaIds: [WABA], expiresAtMs: null }),
  listWabaPhoneNumbers: async () => [numero(PNID_NUEVO)],
  getPhoneNumber: async (id) => numero(id),
  subscribeApp: async () => {},
  requestSmbAppData: async () => ({ ok: true }),
  ...over,
});

const deps = (over: Partial<AddNumberDeps> = {}): AddNumberDeps => ({
  collisionTenant: async (p) => (docs.get(idxPath(p))?.['tenantId'] as string | undefined) ?? null,
  getAsset: async (_t, p) => (docs.get(assetPath(p)) as never) ?? null,
  countActiveNumbers: async () => 1,
  assertQuota: async () => {},
  storeToken: async (name, token) => { secretos.set(`secret://${name}`, token); return `secret://${name}`; },
  removeToken: async (ref) => { secretos.delete(ref); },
  ...over,
});

/** El estado REAL de producción: un número principal sano, conectado y vendiendo. */
const sembrarPrincipalSano = (): void => {
  docs.set(assetPath(PNID_PRINCIPAL), {
    id: PNID_PRINCIPAL, tenantId: TENANT, connectionId: 'main', assetType: 'whatsapp_phone_number',
    externalId: PNID_PRINCIPAL, name: 'el que vende', status: 'active', selected: true, automationMode: 'live',
  });
  docs.set(idxPath(PNID_PRINCIPAL), {
    id: `whatsapp_${PNID_PRINCIPAL}`, tenantId: TENANT, connectionId: 'main',
    assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID_PRINCIPAL, status: 'active',
  });
  docs.set(connPath('main'), {
    id: 'main', tenantId: TENANT, status: 'active', tokenSecretRef: SECRETO_PRINCIPAL, source: 'embedded_signup',
  });
  secretos.set(SECRETO_PRINCIPAL, 'token-del-que-vende');
};

/** Foto del principal, para comparar antes/después sin escribir cinco expects cada vez. */
const fotoDelPrincipal = () => ({
  asset: { ...docs.get(assetPath(PNID_PRINCIPAL)) },
  indice: { ...docs.get(idxPath(PNID_PRINCIPAL)) },
  conexion: { ...docs.get(connPath('main')) },
  secreto: secretos.get(SECRETO_PRINCIPAL),
});

beforeEach(() => {
  docs.clear();
  secretos.clear();
  fallaAlEscribir = false;
  vi.clearAllMocks();
});

describe('elegirNumeroDeCoexistencia — el PNID no se adivina', () => {
  it('un solo número y sin pedido: ese', () => {
    expect(elegirNumeroDeCoexistencia([numero(PNID_NUEVO)])).toEqual({ ok: true, phoneNumberId: PNID_NUEVO });
  });

  it('VARIOS números y sin pedido: ambiguo, no «el primero»', () => {
    // Un WABA puede listar el número que ya vende: elegir el primero es cómo se lo conecta por error.
    expect(elegirNumeroDeCoexistencia([numero(PNID_PRINCIPAL), numero(PNID_NUEVO)])).toEqual({ ok: false, reason: 'phone_number_ambiguo' });
  });

  it('pedido que NO está en la lista de Graph: mismatch', () => {
    expect(elegirNumeroDeCoexistencia([numero(PNID_NUEVO)], '999')).toEqual({ ok: false, reason: 'phone_number_mismatch' });
  });

  it('sin números: no_phone_number', () => {
    expect(elegirNumeroDeCoexistencia([])).toEqual({ ok: false, reason: 'no_phone_number' });
  });
});

describe('elegirWabaDeCoexistencia — el WABA tampoco se adivina (correctivo release-safety)', () => {
  it('un solo WABA autorizado y sin pedido: ese', () => {
    expect(elegirWabaDeCoexistencia([WABA])).toEqual({ ok: true, wabaId: WABA });
  });

  it('VARIOS autorizados y sin pedido: ambiguo — el primero puede ser el de OTRO negocio', () => {
    expect(elegirWabaDeCoexistencia([WABA, 'waba-2'])).toEqual({ ok: false, motivo: 'waba_ambiguo' });
  });

  it('un pedido explícito tiene que estar autorizado por el token', () => {
    expect(elegirWabaDeCoexistencia([WABA, 'waba-2'], 'waba-2')).toEqual({ ok: true, wabaId: 'waba-2' });
    expect(elegirWabaDeCoexistencia([WABA], 'waba-de-otro')).toEqual({ ok: false, motivo: 'waba_no_autorizado' });
  });

  it('sin ninguno autorizado: sin_waba', () => {
    expect(elegirWabaDeCoexistencia([])).toEqual({ ok: false, motivo: 'sin_waba' });
    expect(elegirWabaDeCoexistencia([], '  ')).toEqual({ ok: false, motivo: 'sin_waba' });
  });
});

describe('runCoexistenceConnect — el número que vende no se toca', () => {
  it('conecta el número nuevo en su propia conexión wa_{pnid}', async () => {
    sembrarPrincipalSano();

    const r = await runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps());

    expect(r).toMatchObject({ ok: true, connectionId: `wa_${PNID_NUEVO}`, phoneNumberId: PNID_NUEVO, replay: false });
    expect(docs.get(connPath(`wa_${PNID_NUEVO}`))?.['source']).toBe('embedded_signup');
  });

  it('el principal queda IDÉNTICO: conexión, token, selected, automationMode e índice', async () => {
    sembrarPrincipalSano();
    const antes = fotoDelPrincipal();

    await runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps());

    expect(fotoDelPrincipal()).toEqual(antes);
  });

  it('el token del nuevo va a SU secreto, jamás al del principal', async () => {
    sembrarPrincipalSano();

    await runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps());

    expect(secretos.get(SECRETO_PRINCIPAL)).toBe('token-del-que-vende');
    expect(secretos.get(`secret://meta-token-${TENANT}-${PNID_NUEVO}`)).toBe('token-del-signup');
  });

  it('el número nuevo nace MUDO: sin automationMode, sin selected y con canal propio', async () => {
    sembrarPrincipalSano();

    await runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps());

    const asset = docs.get(assetPath(PNID_NUEVO))!;
    expect(asset).not.toHaveProperty('automationMode');
    expect(asset['selected']).toBe(false);
    expect(asset['sessionKey']).toBe(`wa_${PNID_NUEVO}`);
  });

  it('el segundo número NO altera el ruteo del actual: cada PNID a su conexión', async () => {
    sembrarPrincipalSano();

    await runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps());

    expect(docs.get(idxPath(PNID_PRINCIPAL))?.['connectionId']).toBe('main');
    expect(docs.get(idxPath(PNID_NUEVO))?.['connectionId']).toBe(`wa_${PNID_NUEVO}`);
  });
});

describe('runCoexistenceConnect — el PNID se resuelve SERVER-SIDE', () => {
  it('sin `phoneNumberId` en el input, sale de GET /<WABA>/phone_numbers', async () => {
    sembrarPrincipalSano();
    const llamadas: string[] = [];

    const r = await runCoexistenceConnect(
      TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner',
      graph({ listWabaPhoneNumbers: async (w) => { llamadas.push(w); return [numero(PNID_NUEVO)]; } }),
      deps(),
    );

    expect(llamadas).toEqual([WABA]);
    expect(r).toMatchObject({ ok: true, phoneNumberId: PNID_NUEVO });
  });

  it('si el WABA lista DOS números y nadie desempata, no se conecta nada', async () => {
    sembrarPrincipalSano();
    const antes = fotoDelPrincipal();

    const r = await runCoexistenceConnect(
      TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner',
      graph({ listWabaPhoneNumbers: async () => [numero(PNID_PRINCIPAL), numero(PNID_NUEVO)] }),
      deps(),
    );

    expect(r).toEqual({ ok: false, reason: 'phone_number_ambiguo' });
    expect(fotoDelPrincipal()).toEqual(antes);
    expect(docs.has(connPath(`wa_${PNID_NUEVO}`))).toBe(false);
  });

  it('si desempatan CON el número principal, se rechaza sin escribir', async () => {
    sembrarPrincipalSano();
    const antes = fotoDelPrincipal();

    const r = await runCoexistenceConnect(
      TENANT, { code: 'code-de-prueba', wabaId: WABA, phoneNumberId: PNID_PRINCIPAL }, 'uid-owner',
      graph({ listWabaPhoneNumbers: async () => [numero(PNID_PRINCIPAL), numero(PNID_NUEVO)] }),
      deps(),
    );

    expect(r).toEqual({ ok: false, reason: 'is_main_number' });
    expect(fotoDelPrincipal()).toEqual(antes);
  });

  it('DEFECTO (correctivo release-safety): token que autoriza DOS WABAs y sin `wabaId` ⇒ rechazo, no «el primero»', async () => {
    // El paralelo exacto de `elegirNumeroDeCoexistencia`: adivinar el primer WABA autorizado es
    // cómo se termina operando sobre la cuenta equivocada — un token de Tech Provider puede
    // alcanzar más de un negocio (cardinalidad real por confirmar en el Programa 2).
    sembrarPrincipalSano();
    const antes = fotoDelPrincipal();
    const listados: string[] = [];

    const r = await runCoexistenceConnect(
      TENANT, { code: 'code-de-prueba' }, 'uid-owner',
      graph({
        debugToken: async () => ({ isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], wabaIds: [WABA, 'waba-2'], expiresAtMs: null }),
        listWabaPhoneNumbers: async (w) => { listados.push(w); return [numero(PNID_NUEVO)]; },
      }),
      deps(),
    );

    expect(r.ok).toBe(false);
    // Reason PROPIA (integración del cierre): el panel puede pedir la elección explícita en vez
    // de mostrar un error genérico. Sigue siendo el mismo rechazo fail-closed.
    expect((r as { reason: string }).reason).toBe('waba_ambiguo');
    expect(listados).toEqual([]); // ni siquiera se listaron números: no se adivinó ningún WABA
    expect(fotoDelPrincipal()).toEqual(antes);
    expect(docs.has(connPath(`wa_${PNID_NUEVO}`))).toBe(false);
    expect(secretos.size).toBe(1); // solo el del principal
  });

  it('con UN solo WABA autorizado y sin `wabaId`, sigue como hoy', async () => {
    sembrarPrincipalSano();
    const r = await runCoexistenceConnect(TENANT, { code: 'code-de-prueba' }, 'uid-owner', graph(), deps());
    expect(r).toMatchObject({ ok: true, connectionId: `wa_${PNID_NUEVO}`, phoneNumberId: PNID_NUEVO });
  });

  it('un `wabaId` explícito entre VARIOS autorizados sigue funcionando', async () => {
    sembrarPrincipalSano();
    const r = await runCoexistenceConnect(
      TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner',
      graph({ debugToken: async () => ({ isValid: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], wabaIds: [WABA, 'waba-2'], expiresAtMs: null }) }),
      deps(),
    );
    expect(r).toMatchObject({ ok: true, phoneNumberId: PNID_NUEVO });
  });

  it('un WABA que el token no respalda no se toca', async () => {
    sembrarPrincipalSano();

    const r = await runCoexistenceConnect(
      TENANT, { code: 'code-de-prueba', wabaId: 'waba-de-otro' }, 'uid-owner',
      graph(), deps(),
    );

    expect(r).toEqual({ ok: false, reason: 'no_waba' });
  });

  it('token inválido o sin permisos: nada se escribe y el principal sigue igual', async () => {
    sembrarPrincipalSano();
    const antes = fotoDelPrincipal();

    expect(await runCoexistenceConnect(TENANT, { code: 'c', wabaId: WABA }, 'u', graph({ debugToken: async () => ({ isValid: false, scopes: [], wabaIds: [], expiresAtMs: null }) }), deps()))
      .toEqual({ ok: false, reason: 'token_invalid' });
    expect(await runCoexistenceConnect(TENANT, { code: 'c', wabaId: WABA }, 'u', graph({ debugToken: async () => ({ isValid: true, scopes: [], wabaIds: [WABA], expiresAtMs: null }) }), deps()))
      .toEqual({ ok: false, reason: 'scopes_insuficientes' });
    expect(fotoDelPrincipal()).toEqual(antes);
    expect(secretos.size).toBe(1);
  });
});

describe('runCoexistenceConnect — replay y fallo parcial', () => {
  it('REPLAY: el segundo callback devuelve lo mismo, sin otra conexión ni otro secreto', async () => {
    sembrarPrincipalSano();
    const primero = await runCoexistenceConnect(TENANT, { code: 'code-1', wabaId: WABA }, 'uid-owner', graph(), deps());
    const secretosTrasPrimero = [...secretos.keys()].sort();
    const conexionTrasPrimero = { ...docs.get(connPath(`wa_${PNID_NUEVO}`)) };

    const segundo = await runCoexistenceConnect(TENANT, { code: 'code-2', wabaId: WABA }, 'uid-owner', graph(), deps());

    expect(segundo).toMatchObject({ ok: true, connectionId: `wa_${PNID_NUEVO}`, phoneNumberId: PNID_NUEVO, replay: true });
    expect((primero as { connectionId: string }).connectionId).toBe((segundo as { connectionId: string }).connectionId);
    expect([...secretos.keys()].sort()).toEqual(secretosTrasPrimero);
    expect(docs.get(connPath(`wa_${PNID_NUEVO}`))).toEqual(conexionTrasPrimero);
  });

  it('COLISIÓN cross-tenant: se rechaza con el dueño, sin escribir nada', async () => {
    sembrarPrincipalSano();
    docs.set(idxPath(PNID_NUEVO), { id: `whatsapp_${PNID_NUEVO}`, tenantId: OTRO_TENANT, connectionId: `wa_${PNID_NUEVO}`, externalId: PNID_NUEVO, status: 'active' });

    const r = await runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps());

    expect(r).toEqual({ ok: false, reason: 'phone_number_collision', conflictTenantId: OTRO_TENANT });
    expect(docs.get(idxPath(PNID_NUEVO))?.['tenantId']).toBe(OTRO_TENANT);
    expect(docs.has(connPath(`wa_${PNID_NUEVO}`))).toBe(false);
  });

  it('FALLO DE PERSISTENCIA: ni conexión aparentemente activa, ni secreto huérfano, ni daño al principal', async () => {
    sembrarPrincipalSano();
    const antes = fotoDelPrincipal();
    fallaAlEscribir = true;

    await expect(runCoexistenceConnect(TENANT, { code: 'code-de-prueba', wabaId: WABA }, 'uid-owner', graph(), deps())).rejects.toThrow();

    expect(docs.has(connPath(`wa_${PNID_NUEVO}`))).toBe(false);
    expect(docs.has(assetPath(PNID_NUEVO))).toBe(false);
    expect(docs.has(idxPath(PNID_NUEVO))).toBe(false);
    expect([...secretos.keys()]).toEqual([SECRETO_PRINCIPAL]);
    expect(fotoDelPrincipal()).toEqual(antes);
  });
});
