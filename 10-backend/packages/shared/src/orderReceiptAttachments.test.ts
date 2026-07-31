import { describe, it, expect } from 'vitest';
import { readOrderReceiptAttachments, receiptAttachmentsState } from './orderReceiptAttachments.js';

/**
 * ADR-0016 §5 — Contrato que el panel de Pedidos lee para saber que hay un comprobante. Vive en
 * shared porque lo usan las DOS puntas (backend y panel): con una copia por lado, una tolera lo
 * que la otra rompe y el vendedor ve una tarjeta distinta según la pantalla.
 */
const ATT = 'att_0123456789abcdef01234567';
const OTRO = 'att_ffffffffffffffffffffffff';

describe('readOrderReceiptAttachments — lectura defensiva', () => {
  it('un pedido anterior al ADR no explota y no inventa comprobantes', () => {
    expect(readOrderReceiptAttachments({ id: 'ord_1' })).toEqual({
      candidateIds: [],
      linkedIds: [],
      statusDrivenBy: null,
    });
    expect(readOrderReceiptAttachments(null)).toEqual({ candidateIds: [], linkedIds: [], statusDrivenBy: null });
    expect(readOrderReceiptAttachments('no soy un pedido')).toEqual({
      candidateIds: [],
      linkedIds: [],
      statusDrivenBy: null,
    });
  });

  it('descarta basura, deduplica y conserva el orden', () => {
    const sucio = {
      receiptAttachments: {
        candidateIds: [ATT, ATT, 42, null, '', OTRO],
        linkedIds: 'no-es-lista',
        statusDrivenBy: '',
      },
    };
    expect(readOrderReceiptAttachments(sucio)).toEqual({
      candidateIds: [ATT, OTRO],
      linkedIds: [],
      statusDrivenBy: null,
    });
  });
});

describe('receiptAttachmentsState — qué muestra la tarjeta del pedido', () => {
  it('vinculado por una PERSONA ⇒ hay comprobante', () => {
    expect(receiptAttachmentsState({ receiptAttachments: { candidateIds: [ATT], linkedIds: [ATT] } })).toBe('linked');
  });

  /**
   * DISCRIMINANTE: una SUGERENCIA del sistema no es un comprobante. Si el panel las tratara
   * igual, el pedido diría "comprobante recibido" por una foto que nadie confirmó — que es
   * exactamente el comportamiento que ADR-0016 vino a matar.
   */
  it('solo sugerido por el sistema ⇒ candidato, NUNCA comprobante', () => {
    expect(receiptAttachmentsState({ receiptAttachments: { candidateIds: [ATT], linkedIds: [] } })).toBe('candidate');
  });

  it('sin nada de este eje ⇒ none (puede haber un comprobante legacy en payment)', () => {
    expect(receiptAttachmentsState({ id: 'ord_1' })).toBe('none');
    expect(receiptAttachmentsState({ receiptAttachments: { candidateIds: [], linkedIds: [] } })).toBe('none');
  });
});
