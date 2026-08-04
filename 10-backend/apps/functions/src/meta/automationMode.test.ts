import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0017 §1 — RESOLUCIÓN DEL PERMISO DE AUTOMATIZACIÓN POR NÚMERO.
 * ==================================================================
 * «Un lector puro y compartido decide — no se reimplementa en cada borde, porque dos lecturas del
 * mismo flag terminan divergiendo y la laxa es la que enciende.»
 *
 * Acá se prueba el lector con I/O: qué documentos mira, cómo desempata entre ellos y qué hace
 * cuando la lectura misma se cae. La aritmética de los modos vive en `@vpw/shared` y se prueba
 * allá; esto prueba el ACOPLE con Firestore, que es donde nacen los agujeros.
 */

const docs = new Map<string, Record<string, unknown>>();
/** Paths cuya lectura debe explotar (simula un Firestore intermitente). */
const rotos = new Set<string>();

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (rotos.has(path)) throw new Error('firestore caído');
        return { exists: docs.has(path), data: () => docs.get(path) };
      },
    }),
  }),
  paths: {
    metaAsset: (t: string, id: string) => `tenants/${t}/metaAssets/${id}`,
    metaExternalIndexEntry: (id: string) => `metaExternalIndex/${id}`,
  },
}));

import { resolveAutomationMode, CANAL_SIN_GATE } from './automationMode.js';

/** Multi-tenant: ningún tenant real aparece en el código ni en los tests. */
const TENANT = 'tnt_alpha';
const OTRO_TENANT = 'tnt_beta';
const PNID_ACTUAL = '111222333';
const PNID_NUEVO = '444555666';
const assetPath = (t: string, p: string) => `tenants/${t}/metaAssets/${p}`;

beforeEach(() => {
  docs.clear();
  rotos.clear();
});

describe('resolveAutomationMode — fail-closed antes que nada', () => {
  it('el número recién dado de alta (asset SIN el campo) NO automatiza', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), { externalId: PNID_NUEVO, status: 'active', selected: false });
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.mode).toBe('inactive');
  });

  it('sin asset (número desconocido para el tenant) ⇒ inactive', async () => {
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.mode).toBe('inactive');
  });

  it('sin PNID no hay canal que autorizar ⇒ inactive', async () => {
    expect((await resolveAutomationMode(TENANT, null)).mode).toBe('inactive');
    expect((await resolveAutomationMode(TENANT, '')).mode).toBe('inactive');
  });

  it('si la lectura del asset se CAE, no se automatiza (un error no es una decisión)', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'live' });
    rotos.add(assetPath(TENANT, PNID_ACTUAL));
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL);
    expect(r.mode).toBe('inactive');
    expect(r.origen).toBe('error_lectura');
  });

  it('un valor irreconocible en el asset es `inactive`, no "casi live"', async () => {
    for (const raro of ['LIVE', 'activo', true, 1, { mode: 'live' }]) {
      docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: raro });
      expect((await resolveAutomationMode(TENANT, PNID_ACTUAL)).mode, String(raro)).toBe('inactive');
    }
  });

  it('el número migrado a `live` conserva su permiso', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'live' });
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL);
    expect(r.mode).toBe('live');
    expect(r.origen).toBe('asset');
  });

  it('`shadow` se reconoce tal cual', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'shadow' });
    expect((await resolveAutomationMode(TENANT, PNID_ACTUAL)).mode).toBe('shadow');
  });
});

describe('resolveAutomationMode — ante inconsistencia gana el más restrictivo', () => {
  beforeEach(() => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'live' });
  });

  it('índice `shadow` degrada a un asset `live`', async () => {
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL, { automationMode: 'shadow' });
    expect(r.mode).toBe('shadow');
  });

  it('índice `inactive` apaga a un asset `live`', async () => {
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL, { automationMode: 'inactive' });
    expect(r.mode).toBe('inactive');
  });

  it('índice con un valor irreconocible degrada a inactive (presente y raro SÍ vota)', async () => {
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL, { automationMode: 'LIVE' });
    expect(r.mode).toBe('inactive');
  });

  /**
   * La razón por la que ausente ≠ inactive en el índice: la migración escribe UN campo en UN
   * documento. Si la ausencia en el índice votara, el número que vende quedaría mudo entre las
   * dos escrituras — que es exactamente el desenlace que ADR-0017 manda evitar.
   */
  it('índice SIN el campo no degrada nada: la ausencia no vota', async () => {
    expect((await resolveAutomationMode(TENANT, PNID_ACTUAL, { tenantId: TENANT })).mode).toBe('live');
    expect((await resolveAutomationMode(TENANT, PNID_ACTUAL, undefined)).mode).toBe('live');
    expect((await resolveAutomationMode(TENANT, PNID_ACTUAL, null)).mode).toBe('live');
  });

  it('un asset `shadow` no lo sube a `live` ningún índice', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'shadow' });
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL, { automationMode: 'live' });
    expect(r.mode).toBe('shadow');
  });
});

describe('resolveAutomationMode — aislamiento por tenant', () => {
  it('el permiso de un tenant no alcanza al mismo PNID de otro tenant', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'live' });
    expect((await resolveAutomationMode(OTRO_TENANT, PNID_ACTUAL)).mode).toBe('inactive');
  });
});

/**
 * ADR-0017 §2 — la sesión es por canal, PERO las conversaciones que ya existen viven en
 * `sessions/active` y no se migran. De ahí la asimetría: campo AUSENTE ⇒ canal heredado.
 */
describe('resolveAutomationMode — sessionKey del canal', () => {
  it('asset heredado (sin `sessionKey`) ⇒ canal `active`: no se mueve ninguna conversación', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'live' });
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL);
    expect(r.sessionKey).toBe('active');
  });

  it('asset con `sessionKey` propia ⇒ esa clave (el número adicional tiene su canal)', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), { automationMode: 'shadow', sessionKey: `wa_${PNID_NUEVO}` });
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.sessionKey).toBe(`wa_${PNID_NUEVO}`);
  });

  it('el índice puede aportar la clave si el asset no la tiene', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), { automationMode: 'shadow' });
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO, { sessionKey: `wa_${PNID_NUEVO}` });
    expect(r.sessionKey).toBe(`wa_${PNID_NUEVO}`);
  });

  it('el asset MANDA sobre el índice cuando los dos declaran clave', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), { sessionKey: 'wa_asset' });
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO, { sessionKey: 'wa_indice' });
    expect(r.sessionKey).toBe('wa_asset');
  });

  /**
   * Una clave malformada NO cae a `active`: eso fusionaría la conversación del número nuevo con
   * la del que ya vende (carrito, takeover y pedido pendiente compartidos). Ante basura se DERIVA
   * del PNID, que es la opción que nunca comparte.
   */
  it('clave malformada ⇒ se deriva del PNID, jamás se cae al canal heredado', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), { sessionKey: 'wa/../active' });
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.sessionKey).toBe(`wa_${PNID_NUEVO}`);
    expect(r.sessionKey).not.toBe('active');
  });

  it('dos números del mismo tenant NO comparten canal', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { automationMode: 'live' });
    docs.set(assetPath(TENANT, PNID_NUEVO), { automationMode: 'live', sessionKey: `wa_${PNID_NUEVO}` });
    const a = await resolveAutomationMode(TENANT, PNID_ACTUAL);
    const b = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(a.sessionKey).not.toBe(b.sessionKey);
  });

  it('con la lectura caída la clave cae al canal heredado (y el modo, a inactive)', async () => {
    rotos.add(assetPath(TENANT, PNID_ACTUAL));
    const r = await resolveAutomationMode(TENANT, PNID_ACTUAL);
    expect(r).toEqual({ mode: 'inactive', sessionKey: 'active', origen: 'error_lectura' });
  });
});

/**
 * DEFECTO 5 — «ausente ⇒ canal heredado» es correcto SOLO para el número que ya vendía cuando
 * había uno solo por tenant. Para cualquier otro es catastrófico: al pasar a `live` compartiría
 * carrito, estado de checkout y takeover con el número que está vendiendo.
 *
 * El desempate no puede ser `selected` (un admin lo cambia al elegir el remitente por defecto y le
 * mudaría el canal al número que vende, con conversaciones vivas adentro). Se usa `connectionId`:
 * los números ADICIONALES viven en su propia conexión `wa_{pnid}` y eso no lo cambia ninguna
 * acción de panel.
 */
describe('resolveAutomationMode — el canal heredado es de UN solo número', () => {
  it('un número de conexión adicional SIN `sessionKey` estrena canal, no hereda `active`', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), {
      externalId: PNID_NUEVO, connectionId: `wa_${PNID_NUEVO}`, status: 'active', automationMode: 'live',
    });
    const r = await resolveAutomationMode(TENANT, PNID_NUEVO);
    expect(r.sessionKey).toBe(`wa_${PNID_NUEVO}`);
    expect(r.sessionKey).not.toBe('active');
    expect(r.mode).toBe('live'); // el permiso no se toca: lo que cambia es DÓNDE conversa
  });

  it('el número heredado (conexión `main`) sigue en `active`: no se mueve ninguna conversación', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { externalId: PNID_ACTUAL, connectionId: 'main', automationMode: 'live' });
    expect((await resolveAutomationMode(TENANT, PNID_ACTUAL)).sessionKey).toBe('active');
  });

  it('un asset viejo sin `connectionId` se sigue tratando como heredado', async () => {
    docs.set(assetPath(TENANT, PNID_ACTUAL), { externalId: PNID_ACTUAL, automationMode: 'live' });
    expect((await resolveAutomationMode(TENANT, PNID_ACTUAL)).sessionKey).toBe('active');
  });

  it('una `sessionKey` declarada manda por encima de la conexión', async () => {
    docs.set(assetPath(TENANT, PNID_NUEVO), { connectionId: `wa_${PNID_NUEVO}`, sessionKey: 'active' });
    expect((await resolveAutomationMode(TENANT, PNID_NUEVO)).sessionKey).toBe('active');
  });
});

describe('CANAL_SIN_GATE — el escape EXPLÍCITO para lo que no es un número de WhatsApp', () => {
  it('automatiza sobre el canal heredado (Instagram/Messenger no tienen PNID que autorizar)', () => {
    expect(CANAL_SIN_GATE.mode).toBe('live');
    expect(CANAL_SIN_GATE.sessionKey).toBe('active');
  });

  it('es inmutable: nadie puede convertirlo en el default de WhatsApp por accidente', () => {
    expect(Object.isFrozen(CANAL_SIN_GATE)).toBe(true);
  });
});
