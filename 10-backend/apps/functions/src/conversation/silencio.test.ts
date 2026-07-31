import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §12 — LA REGLA DE SILENCIO, UNA SOLA VEZ.
 * ==================================================
 * Antes había tres versiones parciales de la misma pregunta: la del motor (completa), el
 * re-chequeo fresco del tail (miraba `humanTakeover` e ignoraba `botEnabled`) y la del camino de
 * ubicación (rama por rama). Acá se prueba la ÚNICA que queda, y sobre todo el borde nuevo: el
 * guard autoritativo pre-envío, con su excepción acotada y su comportamiento fail-closed.
 */

const docs = new Map<string, Record<string, unknown>>();
/** Simula una caída transitoria de Firestore en la lectura de la sesión. */
let lecturaRota = false;

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (lecturaRota) throw new Error('firestore no disponible');
        return { exists: docs.has(path), data: () => docs.get(path) };
      },
    }),
  }),
  paths: { session: (t: string, c: string) => `tenants/${t}/customers/${c}/sessions/active` },
}));

let botEnabled = true;
vi.mock('./agentConfig.js', () => ({ getAgentConfig: vi.fn(async () => ({ botEnabled })) }));

import { evaluarSilencioPreEnvio, botSilenciadoEnChat, EXIGE_SILENCIO_LIBRE } from './silencio.js';

const TENANT = 'tnt_sil';
const CLIENTE = '595991110000';
const SESION = `tenants/${TENANT}/customers/${CLIENTE}/sessions/active`;

const sesion = (context: Record<string, unknown>) => docs.set(SESION, { context });

beforeEach(() => {
  docs.clear();
  lecturaRota = false;
  botEnabled = true;
});

describe('evaluarSilencioPreEnvio — respuesta AUTÓNOMA del bot', () => {
  it('sin sesión y con el bot encendido: libre (el camino feliz no cambia)', async () => {
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, EXIGE_SILENCIO_LIBRE)).toBe('libre');
  });

  it('un vendedor tomó el chat: silenciado', async () => {
    sesion({ humanTakeover: true });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, EXIGE_SILENCIO_LIBRE)).toBe('silenciado');
  });

  it('bot apagado desde el panel: silenciado (es la MISMA regla, no una copia parcial)', async () => {
    botEnabled = false;
    sesion({ humanTakeover: false });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, EXIGE_SILENCIO_LIBRE)).toBe('silenciado');
  });

  it('sin expectativa explícita, el default es la vara ESTRICTA', async () => {
    sesion({ humanTakeover: true });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE)).toBe('silenciado');
  });

  it('FAIL-CLOSED: si la lectura se cae, se calla', async () => {
    lecturaRota = true;
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, EXIGE_SILENCIO_LIBRE)).toBe('silenciado');
  });
});

describe('evaluarSilencioPreEnvio — confirmación del handoff PROPIO', () => {
  /**
   * Sin esta excepción el guard rompería HANDOFF-2: las cuatro derivaciones toman el chat y
   * DESPUÉS confirman («te paso con Ana»). Medirlas con la vara estricta las mataría siempre y el
   * bot pasaría a humano en silencio, que es exactamente la mentira que HANDOFF-2 vino a matar.
   */
  it('el takeover lo tomó ESTE turno (mismo sourceId): sale', async () => {
    sesion({ humanTakeover: true, handoffReason: 'customer_requested', handoffSourceId: 'wamid.T1' });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, { modo: 'confirma_handoff_propio', sourceId: 'wamid.T1' })).toBe('libre');
  });

  it('sin wamid (dev/simulador) el sourceId es null en los dos lados: sigue siendo propio', async () => {
    sesion({ humanTakeover: true, handoffSourceId: null });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, { modo: 'confirma_handoff_propio', sourceId: null })).toBe('libre');
  });

  it('el takeover vigente es AJENO (un vendedor lo tomó en el medio): NO sale', async () => {
    sesion({ humanTakeover: true, handoffReason: 'seller_manual', handoffSourceId: 'otro-origen' });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, { modo: 'confirma_handoff_propio', sourceId: 'wamid.T1' })).toBe('silenciado');
  });

  it('con el bot APAGADO ni la confirmación propia sale: apagar el bot calla todo', async () => {
    botEnabled = false;
    sesion({ humanTakeover: true, handoffSourceId: 'wamid.T1' });
    expect(await evaluarSilencioPreEnvio(TENANT, CLIENTE, { modo: 'confirma_handoff_propio', sourceId: 'wamid.T1' })).toBe('silenciado');
  });
});

describe('botSilenciadoEnChat — la consulta suelta responde lo mismo', () => {
  it('coincide con el guard en los tres estados que importan', async () => {
    expect(await botSilenciadoEnChat(TENANT, CLIENTE)).toBe(false);
    sesion({ humanTakeover: true });
    expect(await botSilenciadoEnChat(TENANT, CLIENTE)).toBe(true);
    docs.clear();
    botEnabled = false;
    expect(await botSilenciadoEnChat(TENANT, CLIENTE)).toBe(true);
  });
});
