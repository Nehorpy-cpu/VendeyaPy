import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ADR-0016 §10 — EL LECTOR del nivel A, en el borde de Firestore.
 * ===============================================================
 * El parser puro ya está probado en `@vpw/shared` (`attachmentRollout.test.ts`). Lo que se prueba
 * acá es lo que el parser NO puede ver: qué pasa cuando el documento no existe, cuando existe pero
 * con otra forma, y —sobre todo— cuando la lectura misma se cae. Ese último caso es el que separa
 * un flag de seguridad de un flag decorativo: si un Firestore intermitente encendiera la ingesta,
 * el interruptor no serviría para nada.
 *
 * Y la asimetría deliberada: el FLAG falla cerrado, los LÍMITES siguen cayendo a los defaults del
 * código (que son los más restrictivos), porque con la ingesta encendida un hipo de infra no puede
 * convertirse en "no recibo más archivos de nadie".
 */

let leer: () => Promise<{ exists: boolean; data: () => unknown }>;

vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: () => ({ get: () => leer() }) }),
}));

import {
  getAttachmentIngestPolicy,
  getAttachmentIngestLimits,
  ATTACHMENT_INGEST_DISABLED,
  DEFAULT_ATTACHMENT_LIMITS,
} from './attachmentLimits.js';

const docCon = (data: unknown) => async () => ({ exists: true, data: () => data });
const sinDoc = async () => ({ exists: false, data: () => undefined });

beforeEach(() => {
  leer = sinDoc;
});

describe('getAttachmentIngestPolicy — nivel A fail-closed (ADR-0016 §10)', () => {
  it('config del tenant AUSENTE ⇒ apagado (es el estado del día del deploy)', async () => {
    expect(await getAttachmentIngestPolicy('tnt_x')).toEqual(ATTACHMENT_INGEST_DISABLED);
  });

  it('solo el booleano EXACTO enciende', async () => {
    leer = docCon({ ingest: { enabled: true } });
    expect((await getAttachmentIngestPolicy('tnt_x')).enabled).toBe(true);
  });

  const APAGADOS: Array<[string, unknown]> = [
    ['sin campo `ingest`', {}],
    ['`ingest` sin `enabled`', { ingest: { maxBytes: 1_000_000 } }],
    ['`enabled: false`', { ingest: { enabled: false } }],
    ['`enabled: "true"`', { ingest: { enabled: 'true' } }],
    ['`enabled: 1`', { ingest: { enabled: 1 } }],
    ['`enabled: "1"`', { ingest: { enabled: '1' } }],
    ['`enabled: "yes"`', { ingest: { enabled: 'yes' } }],
    ['`enabled: null`', { ingest: { enabled: null } }],
    ['`ingest` como arreglo', { ingest: [{ enabled: true }] }],
    ['`ingest` como string', { ingest: 'true' }],
    ['doc vacío', undefined],
  ];

  for (const [caso, data] of APAGADOS) {
    it(`${caso} ⇒ apagado`, async () => {
      leer = docCon(data);
      expect((await getAttachmentIngestPolicy('tnt_x')).enabled).toBe(false);
    });
  }

  it('si la LECTURA se cae, queda apagado: un error de infra no es una decisión de encendido', async () => {
    leer = async () => {
      throw new Error('firestore no disponible');
    };
    expect(await getAttachmentIngestPolicy('tnt_x')).toEqual(ATTACHMENT_INGEST_DISABLED);
  });

  it('encendido y límites del tenant conviven en el MISMO doc (una sola lectura)', async () => {
    leer = docCon({ ingest: { enabled: true, maxBytes: 1_000_000, allowedMimeTypes: ['application/pdf'] } });
    const politica = await getAttachmentIngestPolicy('tnt_x');
    expect(politica.enabled).toBe(true);
    expect(politica.limits.maxBytes).toBe(1_000_000);
    expect(politica.limits.allowedMimeTypes).toEqual(['application/pdf']);
  });

  it('apagar el flag NO endurece los límites: son ejes distintos', async () => {
    leer = docCon({ ingest: { enabled: false, maxBytes: 1_000_000 } });
    const politica = await getAttachmentIngestPolicy('tnt_x');
    expect(politica.enabled).toBe(false);
    expect(politica.limits.maxBytes).toBe(1_000_000);
  });

  /**
   * El gate de comprobantes lee los límites por acá para intersecarlos con su propia config
   * (ADR-0016 §8). Ese contrato no cambió: sigue devolviendo SOLO límites y sigue cayendo a los
   * defaults cuando no hay nada que leer.
   */
  it('`getAttachmentIngestLimits` mantiene su contrato para el gate', async () => {
    expect(await getAttachmentIngestLimits('tnt_x')).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    leer = async () => {
      throw new Error('firestore no disponible');
    };
    expect(await getAttachmentIngestLimits('tnt_x')).toEqual(DEFAULT_ATTACHMENT_LIMITS);
  });
});
