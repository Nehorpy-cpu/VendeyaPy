/**
 * connectFlow.seleccionWaba.test.ts — SELECCIÓN PENDIENTE de WABA (ADR-0020, G2)
 * ===============================================================================
 * Con MÚLTIPLES WABAs autorizados y sin `wabaId`, el `code` YA fue canjeado y reclamado
 * (single-flight): no se puede responder «reintentá» sin otro login. El contrato nuevo:
 *
 *  · el token se guarda en un secreto PENDIENTE determinístico (`meta-token-pending-{tenant}`),
 *  · se emite un nonce de modo `waba_selection` (tenant+uid, TTL 10 min, uso único) que guarda
 *    ADEMÁS la referencia del secreto pendiente y la lista SANEADA de WABAs (id + nombre),
 *  · `runMetaConnect` devuelve `waba_selection_required` con `selectionId` + `wabas`,
 *  · `runCompleteMetaConnectWaba` consume el nonce, RETIRA el secreto pendiente y termina el
 *    MISMO camino de conexión con el WABA elegido.
 *
 * Fail-closed: nonce vencido/replay, wabaId fuera de la lista o secreto pendiente ausente ⇒
 * `seleccion_invalida` (el owner rehace el login; el code era de un solo uso igual).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetaPhoneNumber, MetaGraphClient, DebugTokenResult } from './graphClient.js';

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const secretos = new Map<string, string>();
  return {
    docs,
    secretos,
    escribirAssets: vi.fn(async (_t: string, _c: string, _a: unknown[]) => {}),
    guardarSecreto: vi.fn(async (name: string, valor: string) => {
      const ref = `secret://${name}`;
      secretos.set(ref, valor);
      return ref;
    }),
    borrarSecreto: vi.fn(async (ref: string) => {
      secretos.delete(ref);
    }),
    auditar: vi.fn(async (_e: unknown) => {}),
    verificar: vi.fn(async () => ({ ready: true, reason: 'ok', status: 'active' })),
  };
});

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: h.docs.has(path), data: () => h.docs.get(path) }),
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        h.docs.set(path, opts?.merge ? { ...(h.docs.get(path) ?? {}), ...data } : { ...data });
      },
    }),
    // El consumo del nonce de selección es transaccional (uso único).
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const ops: Array<{ tipo: 'set' | 'delete'; path: string; data?: Record<string, unknown> }> = [];
      const tx = {
        get: async (ref: { path: string }) => ({ exists: h.docs.has(ref.path), data: () => h.docs.get(ref.path) }),
        set: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ tipo: 'set', path: ref.path, data }),
        delete: (ref: { path: string }) => ops.push({ tipo: 'delete', path: ref.path }),
      };
      const r = await fn(tx);
      for (const op of ops) {
        if (op.tipo === 'delete') h.docs.delete(op.path);
        else h.docs.set(op.path, op.data!);
      }
      return r;
    },
  }),
  paths: { metaConnection: (t: string, id: string) => `tenants/${t}/metaConnections/${id}` },
}));

vi.mock('../lib/secretStore.js', () => ({
  getSecretStore: () => ({ set: h.guardarSecreto, get: async (ref: string) => h.secretos.get(ref) ?? null, remove: h.borrarSecreto }),
}));

vi.mock('./discovery.js', () => ({
  buildMetaAssets: (i: { phones: MetaPhoneNumber[] }) =>
    i.phones.map((p) => ({ externalId: p.id, assetType: 'whatsapp_phone_number', name: p.id, selected: true })),
  writeDiscoveredAssets: h.escribirAssets,
}));

vi.mock('./preflight.js', () => ({ verifyWhatsappChannel: h.verificar }));

vi.mock('../entitlements/entitlements.js', () => ({
  resolveEntitlements: async () => ({ limits: { maxWhatsappNumbers: 10 } }),
}));

vi.mock('../audit/audit.js', () => ({ recordAudit: h.auditar }));

import { runMetaConnect, runCompleteMetaConnectWaba } from './connectFlow.js';

const TENANT = 'tnt_alpha';
const UID = 'uid-1';
const WABA_A = 'waba_100';
const WABA_B = 'waba_200';
const PNID = '111222333';
const CONN = `tenants/${TENANT}/metaConnections/main`;
const REF_PENDIENTE = `secret://meta-token-pending-${TENANT}`;

const numero = (id: string): MetaPhoneNumber => ({
  id,
  displayPhoneNumber: id,
  verifiedName: '',
  qualityRating: '',
  codeVerificationStatus: '',
});

const SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'];

/** Graph de mentira: el token autoriza DOS WABAs; nunca sale a la red. */
const graphFake = (over: Partial<MetaGraphClient> & { dbg?: Partial<DebugTokenResult> } = {}): MetaGraphClient => ({
  exchangeCode: async () => ({ accessToken: 'token-de-prueba', tokenType: 'bearer', expiresInSec: null }),
  debugToken: async () => ({ isValid: true, scopes: SCOPES, wabaIds: [WABA_A, WABA_B], expiresAtMs: null, ...over.dbg }),
  listWabaPhoneNumbers: async () => [numero(PNID)],
  getPhoneNumber: async () => null,
  subscribeApp: async () => {},
  getWabaName: async (id: string) => (id === WABA_A ? 'Cuenta A' : 'Cuenta B'),
  ...over,
});

beforeEach(() => {
  h.docs.clear();
  h.secretos.clear();
  vi.clearAllMocks();
  h.escribirAssets.mockImplementation(async () => {});
  h.verificar.mockImplementation(async () => ({ ready: true, reason: 'ok', status: 'active' }));
});

/** Corre el connect multi-WABA y devuelve el resultado de selección pendiente (tipado angosto). */
async function pedirSeleccion() {
  const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, UID, graphFake());
  expect(r.ok).toBe(false);
  if (r.ok || r.reason !== 'waba_selection_required') throw new Error(`se esperaba waba_selection_required, vino ${JSON.stringify(r)}`);
  return r;
}

describe('G2 — varios WABAs sin elección ⇒ SELECCIÓN PENDIENTE (no un error terminal)', () => {
  it('devuelve waba_selection_required con selectionId y la lista saneada de WABAs', async () => {
    const r = await pedirSeleccion();

    expect(typeof r.selectionId).toBe('string');
    expect(r.selectionId.length).toBeGreaterThan(10);
    expect(r.wabas).toEqual([
      { id: WABA_A, name: 'Cuenta A' },
      { id: WABA_B, name: 'Cuenta B' },
    ]);
  });

  it('guarda el token en el secreto PENDIENTE determinístico (no en el secreto del tenant)', async () => {
    await pedirSeleccion();

    expect(h.secretos.get(REF_PENDIENTE)).toBe('token-de-prueba');
    expect(h.secretos.has(`secret://meta-token-${TENANT}`)).toBe(false);
  });

  it('no escribe conexión ni assets: la conexión que vende queda intacta', async () => {
    h.docs.set(CONN, { id: 'main', status: 'active', tokenSecretRef: 'secret://previo' });

    await pedirSeleccion();

    expect(h.escribirAssets).not.toHaveBeenCalled();
    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe('secret://previo');
  });

  it('el nonce de selección queda atado a tenant+uid+modo y guarda la referencia pendiente y la lista', async () => {
    const r = await pedirSeleccion();

    const doc = h.docs.get(`metaOAuthStates/${r.selectionId}`)!;
    expect(doc['tenantId']).toBe(TENANT);
    expect(doc['uid']).toBe(UID);
    expect(doc['mode']).toBe('waba_selection');
    expect(doc['pendingSecretRef']).toBe(REF_PENDIENTE);
    expect(Array.isArray(doc['wabas'])).toBe(true);
    expect(typeof doc['expiresAtMs']).toBe('number');
  });

  it('sin nombres de Graph (getWabaName ausente), la lista degrada al id: nunca bloquea la selección', async () => {
    const graph = graphFake();
    delete (graph as Partial<MetaGraphClient>).getWabaName;

    const r = await runMetaConnect(TENANT, { code: 'code-de-prueba' }, UID, graph);
    if (r.ok || r.reason !== 'waba_selection_required') throw new Error('se esperaba waba_selection_required');
    expect(r.wabas.map((w) => w.name)).toEqual([WABA_A, WABA_B]);
  });

  it('sobrescribe a lo sumo UN pendiente por tenant (naming determinístico)', async () => {
    await pedirSeleccion();
    await pedirSeleccion();

    const pendientes = [...h.secretos.keys()].filter((k) => k.includes('pending'));
    expect(pendientes).toEqual([REF_PENDIENTE]);
  });
});

describe('G2 — completeMetaConnectWaba cierra el MISMO camino de conexión', () => {
  it('camino feliz: consume el nonce, retira el pendiente y conecta el WABA elegido', async () => {
    const sel = await pedirSeleccion();

    const r = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, WABA_A, graphFake());

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.selectedPhoneNumberId).toBe(PNID);
    // El MISMO camino: discovery + conexión activa con token por referencia.
    expect(h.escribirAssets).toHaveBeenCalledWith(TENANT, 'main', expect.any(Array));
    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe(`secret://meta-token-${TENANT}`);
    // El secreto pendiente se RETIRÓ al completar.
    expect(h.secretos.has(REF_PENDIENTE)).toBe(false);
  });

  it('nonce vencido ⇒ seleccion_invalida, sin escribir nada', async () => {
    const sel = await pedirSeleccion();
    const path = `metaOAuthStates/${sel.selectionId}`;
    h.docs.set(path, { ...h.docs.get(path)!, expiresAtMs: Date.now() - 1 });

    const r = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, WABA_A, graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('seleccion_invalida');
    expect(h.escribirAssets).not.toHaveBeenCalled();
  });

  it('wabaId fuera de la lista guardada ⇒ seleccion_invalida (no se conecta un WABA no ofrecido)', async () => {
    const sel = await pedirSeleccion();

    const r = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, 'waba_ajena', graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('seleccion_invalida');
    expect(h.escribirAssets).not.toHaveBeenCalled();
    // El nonce ya se quemó y el pendiente ya no queda alcanzable.
    expect(h.docs.has(`metaOAuthStates/${sel.selectionId}`)).toBe(false);
  });

  it('replay del selectionId ⇒ el segundo intento falla (uso único)', async () => {
    const sel = await pedirSeleccion();

    const r1 = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, WABA_A, graphFake());
    const r2 = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, WABA_B, graphFake());

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('seleccion_invalida');
  });

  it('secreto pendiente ausente ⇒ seleccion_invalida (el owner rehace el login)', async () => {
    const sel = await pedirSeleccion();
    h.secretos.delete(REF_PENDIENTE);

    const r = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, WABA_A, graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('seleccion_invalida');
  });

  it('el nonce es de OTRO uid ⇒ seleccion_invalida (atadura tenant+uid)', async () => {
    const sel = await pedirSeleccion();

    const r = await runCompleteMetaConnectWaba(TENANT, 'uid-intruso', sel.selectionId, WABA_A, graphFake());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('seleccion_invalida');
  });

  it('el token pendiente se REVALIDA al completar: si venció, no conecta y la conexión previa queda', async () => {
    h.docs.set(CONN, { id: 'main', status: 'active', tokenSecretRef: 'secret://previo' });
    const sel = await pedirSeleccion();

    const r = await runCompleteMetaConnectWaba(TENANT, UID, sel.selectionId, WABA_A, graphFake({ dbg: { isValid: false } }));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_invalid');
    expect(h.docs.get(CONN)?.['status']).toBe('active');
    expect(h.docs.get(CONN)?.['tokenSecretRef']).toBe('secret://previo');
  });
});
