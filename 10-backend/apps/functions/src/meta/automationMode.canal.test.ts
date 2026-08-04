import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §2 — UNA SOLA AUTORIDAD PARA DERIVAR EL CANAL.
 * =======================================================
 * El canal de un número se derivaba en DOS lugares con criterios distintos: el resolvedor del
 * webhook (`resolveAutomationMode`) y el script de migración (`canalDeclarado`). Y divergían justo
 * donde más caro sale: el resolvedor aceptaba una `sessionKey` declarada SOLO en el índice global,
 * el script solo miraba el asset.
 *
 * Consecuencia concreta del desacuerdo: un número de Coexistence cuyo índice espeja
 * `sessionKey: 'active'` era ruteado por el webhook a la conversación del número que HOY vende
 * —carrito, takeover y checkout compartidos—, mientras el script de migración lo veía en su canal
 * propio y por lo tanto lo dejaba promover a `live`. Las dos mitades del sistema decían cosas
 * distintas sobre el mismo número, y la que enciende era la equivocada.
 *
 * La regla dura que cierra el agujero: una declaración que manda el número al canal HEREDADO solo
 * vale si el asset ES el de la conexión heredada. El canal del número que vende no se reclama por
 * un espejo del índice ni por un valor viejo que quedó dando vueltas.
 */
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: (path: string) => ({ path, get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }) }) }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));
const docs = new Map<string, Record<string, unknown>>();

import { derivarSessionKey } from '@vpw/shared';
import { canalSinGate, resolveAutomationMode } from './automationMode.js';
import { canalDeclarado } from '../../scripts/migrate-whatsapp-automation-mode.mjs';

const TENANT = 't1';
const PNID_HEREDADO = '111222333';
const PNID_NUEVO = '444555666';

/** Matriz de casos: los dos lados TIENEN que contestar lo mismo en cada uno. */
const CASOS: Array<{ nombre: string; pnid: string; asset: Record<string, unknown> | null; indice: Record<string, unknown> | null; esperado: string }> = [
  { nombre: 'asset heredado sin sessionKey', pnid: PNID_HEREDADO, asset: { connectionId: 'main' }, indice: null, esperado: 'active' },
  { nombre: 'asset sin connectionId (anterior al campo)', pnid: PNID_HEREDADO, asset: {}, indice: null, esperado: 'active' },
  { nombre: 'asset de conexión adicional sin sessionKey', pnid: PNID_NUEVO, asset: { connectionId: `wa_${PNID_NUEVO}` }, indice: null, esperado: `wa_${PNID_NUEVO}` },
  { nombre: 'asset con sessionKey propia', pnid: PNID_NUEVO, asset: { connectionId: `wa_${PNID_NUEVO}`, sessionKey: `wa_${PNID_NUEVO}` }, indice: null, esperado: `wa_${PNID_NUEVO}` },
  { nombre: 'asset con sessionKey MALFORMADA', pnid: PNID_NUEVO, asset: { connectionId: `wa_${PNID_NUEVO}`, sessionKey: 'a/b c' }, indice: null, esperado: `wa_${PNID_NUEVO}` },
  {
    nombre: 'índice espejando `active` para una conexión ADICIONAL (el caso que divergía)',
    pnid: PNID_NUEVO,
    asset: { connectionId: `wa_${PNID_NUEVO}` },
    indice: { sessionKey: 'active' },
    esperado: `wa_${PNID_NUEVO}`,
  },
  {
    nombre: 'índice espejando la clave propia',
    pnid: PNID_NUEVO,
    asset: { connectionId: `wa_${PNID_NUEVO}` },
    indice: { sessionKey: `wa_${PNID_NUEVO}` },
    esperado: `wa_${PNID_NUEVO}`,
  },
  { nombre: 'asset heredado que declara `active`', pnid: PNID_HEREDADO, asset: { connectionId: 'main', sessionKey: 'active' }, indice: null, esperado: 'active' },
];

beforeEach(() => docs.clear());

describe('derivarSessionKey — la función PURA que es la única autoridad', () => {
  for (const c of CASOS) {
    it(`${c.nombre} ⇒ ${c.esperado}`, () => {
      expect(derivarSessionKey(c.pnid, c.asset, c.indice)).toBe(c.esperado);
    });
  }

  it('un número de Coexistence NUNCA hereda el canal del que ya vende', () => {
    // Aunque alguien haya escrito `active` a mano en el asset de un número adicional.
    expect(derivarSessionKey(PNID_NUEVO, { connectionId: `wa_${PNID_NUEVO}`, sessionKey: 'active' })).toBe(`wa_${PNID_NUEVO}`);
  });
});

describe('canalSinGate — el escape no puede alcanzar a un número de WhatsApp', () => {
  it('Instagram y Messenger siguen en el canal heredado (deuda DECLARADA, no default silencioso)', () => {
    expect(canalSinGate('instagram').sessionKey).toBe('active');
    expect(canalSinGate('messenger').mode).toBe('live');
  });

  it('WhatsApp LANZA: `live` + `active` juntos es la combinación que ADR-0017 existe para impedir', () => {
    // Un número de Coexistence que obtuviera este objeto automatizaría sobre la conversación del
    // número que ya vende, sin pasar por el permiso. Hoy el webhook no lo hace; esto lo vuelve
    // imposible de hacer por descuido.
    expect(() => canalSinGate('whatsapp')).toThrow(/ADR-0017/);
  });
});

describe('paridad resolvedor ↔ script de migración', () => {
  for (const c of CASOS) {
    it(`${c.nombre}: el webhook y la migración coinciden`, async () => {
      docs.set(`tenants/${TENANT}/metaAssets/${c.pnid}`, { ...(c.asset ?? {}), automationMode: 'live' });

      const delWebhook = await resolveAutomationMode(TENANT, c.pnid, c.indice ?? null);
      const delScript = canalDeclarado(c.asset, c.pnid);

      expect(delWebhook.sessionKey).toBe(c.esperado);
      expect(delScript).toBe(c.esperado);
    });
  }
});
