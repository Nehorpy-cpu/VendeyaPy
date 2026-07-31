import { describe, it, expect } from 'vitest';

/**
 * ADR-0016 §10 — LOS DOS INTERRUPTORES DE ROLLOUT, AMBOS FAIL-CLOSED.
 * ===================================================================
 * «Solo el booleano exacto `true` habilita … Ausente, `false`, la cadena `"true"`, el número `1`
 * o cualquier otra forma significan OFF: la coerción laxa es justamente cómo un flag de seguridad
 * termina encendido sin que nadie lo decida».
 *
 * Este test es la red de ese párrafo. No prueba "que funcione el camino feliz" —eso lo prueban el
 * webhook y el gate— sino que NINGUNA forma parecida a un `true` encienda nada.
 */
import {
  isRolloutFlagEnabled,
  parseAttachmentIngestEnabled,
  parseReceiptGateEnabled,
} from './attachmentRollout.js';

/** Todo lo que un dedo distraído, un import de CSV o un panel mal tipado puede dejar escrito. */
const FORMAS_QUE_NO_ENCIENDEN: readonly unknown[] = [
  undefined,
  null,
  false,
  'true',
  'True',
  'TRUE',
  'false',
  '1',
  1,
  0,
  -1,
  'yes',
  'si',
  'on',
  'enabled',
  '',
  ' ',
  {},
  { enabled: true },
  [],
  [true],
  new Date(),
  NaN,
  Infinity,
];

describe('isRolloutFlagEnabled — solo el booleano exacto `true`', () => {
  it('enciende con `true` y con nada más', () => {
    expect(isRolloutFlagEnabled(true)).toBe(true);
    for (const forma of FORMAS_QUE_NO_ENCIENDEN) {
      expect(isRolloutFlagEnabled(forma), JSON.stringify(forma) ?? String(forma)).toBe(false);
    }
  });

  it('un objeto Boolean(true) tampoco enciende (es un objeto, no el primitivo)', () => {
    // eslint-disable-next-line no-new-wrappers
    expect(isRolloutFlagEnabled(new Boolean(true))).toBe(false);
  });
});

describe('parseAttachmentIngestEnabled — nivel A (`config/attachments`, campo `ingest.enabled`)', () => {
  it('enciende SOLO con el booleano exacto', () => {
    expect(parseAttachmentIngestEnabled({ enabled: true })).toBe(true);
  });

  it('el contenedor ausente o de otra forma es OFF (fail-closed)', () => {
    expect(parseAttachmentIngestEnabled(undefined)).toBe(false);
    expect(parseAttachmentIngestEnabled(null)).toBe(false);
    expect(parseAttachmentIngestEnabled('true')).toBe(false);
    expect(parseAttachmentIngestEnabled(true)).toBe(false); // el flag es un CAMPO, no el doc entero
    expect(parseAttachmentIngestEnabled([{ enabled: true }])).toBe(false);
    expect(parseAttachmentIngestEnabled(42)).toBe(false);
  });

  it('ninguna coerción laxa enciende el nivel A', () => {
    for (const forma of FORMAS_QUE_NO_ENCIENDEN) {
      expect(parseAttachmentIngestEnabled({ enabled: forma }), String(forma)).toBe(false);
    }
  });

  it('convivir con el resto de la config de ingesta no cambia nada', () => {
    expect(parseAttachmentIngestEnabled({ maxBytes: 1_000_000, allowedMimeTypes: ['application/pdf'] })).toBe(false);
    expect(
      parseAttachmentIngestEnabled({ enabled: true, maxBytes: 1_000_000, allowedMimeTypes: ['application/pdf'] }),
    ).toBe(true);
  });
});

describe('parseReceiptGateEnabled — nivel B (doc `config/receiptGate`, campo `enabled`)', () => {
  it('enciende SOLO con el booleano exacto', () => {
    expect(parseReceiptGateEnabled({ enabled: true })).toBe(true);
  });

  it('doc ausente o campo con otra forma ⇒ OFF', () => {
    expect(parseReceiptGateEnabled(undefined)).toBe(false);
    expect(parseReceiptGateEnabled(null)).toBe(false);
    expect(parseReceiptGateEnabled({})).toBe(false);
    for (const forma of FORMAS_QUE_NO_ENCIENDEN) {
      expect(parseReceiptGateEnabled({ enabled: forma }), String(forma)).toBe(false);
    }
  });

  it('el resto de la config del gate (ventana, formatos) no puede encenderlo por sí sola', () => {
    expect(parseReceiptGateEnabled({ windowMinutes: 120, allowedMimeTypes: ['image/jpeg'] })).toBe(false);
  });

  /**
   * Los dos niveles son INDEPENDIENTES (ADR-0016 §10): encender la ingesta no propone comprobantes
   * y encender el gate no habilita descargar. Cada uno lee su propio documento.
   */
  it('los dos flags son independientes: el mismo objeto no enciende los dos por accidente', () => {
    const soloIngesta = { enabled: true, maxBytes: 1_000_000 };
    expect(parseAttachmentIngestEnabled(soloIngesta)).toBe(true);
    expect(parseAttachmentIngestEnabled({ windowMinutes: 120 })).toBe(false);
  });
});
