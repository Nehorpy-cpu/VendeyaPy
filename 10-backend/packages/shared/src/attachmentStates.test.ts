import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_CLASSIFICATION_TRANSITIONS,
  ATTACHMENT_INGEST_TRANSITIONS,
  canClassificationTransition,
  canIngestTransition,
  checkClassificationTransition,
  checkIngestTransition,
  classificationTransitionActors,
  ingestTransitionActors,
  isAttachmentActor,
  isAttachmentClassification,
  isAttachmentIngestState,
  isAttachmentStored,
  isPaymentRelatedClassification,
  isTerminalClassification,
  isTerminalIngestState,
  nextClassifications,
  nextIngestStates,
} from './attachmentStates.js';
import {
  ATTACHMENT_CLASSIFICATION,
  ATTACHMENT_INGEST_STATE,
  ATTACHMENT_INITIAL_CLASSIFICATION,
  ATTACHMENT_INITIAL_INGEST_STATE,
} from './types/attachment.types.js';
import type {
  AttachmentClassification,
  AttachmentIngestState,
} from './types/attachment.types.js';

describe('eje INGESTA — matriz completa', () => {
  it('el camino feliz completo es legal para system', () => {
    expect(canIngestTransition('received', 'downloading', 'system')).toBe(true);
    expect(canIngestTransition('downloading', 'verifying', 'system')).toBe(true);
    expect(canIngestTransition('verifying', 'stored', 'system')).toBe(true);
  });

  it('los rechazos tempranos y tardíos son legales', () => {
    expect(canIngestTransition('received', 'rejected', 'system')).toBe(true);
    expect(canIngestTransition('downloading', 'rejected', 'system')).toBe(true);
    expect(canIngestTransition('verifying', 'rejected', 'system')).toBe(true);
    expect(canIngestTransition('downloading', 'download_failed', 'system')).toBe(true);
  });

  it('NINGUNA transición de ingesta la puede disparar un humano', () => {
    for (const from of ATTACHMENT_INGEST_STATE) {
      for (const to of ATTACHMENT_INGEST_STATE) {
        expect(canIngestTransition(from, to, 'human')).toBe(false);
      }
    }
  });

  it('stored / rejected / download_failed son terminales', () => {
    for (const terminal of ['stored', 'rejected', 'download_failed'] as AttachmentIngestState[]) {
      expect(isTerminalIngestState(terminal)).toBe(true);
      expect(nextIngestStates(terminal)).toEqual([]);
      for (const to of ATTACHMENT_INGEST_STATE) {
        if (to === terminal) continue;
        expect(checkIngestTransition(terminal, to, 'system')).toEqual({
          ok: false,
          reason: 'terminal_state',
        });
      }
    }
  });

  it('saltos ilegales: received→stored, received→verifying, verifying→downloading', () => {
    expect(checkIngestTransition('received', 'stored', 'system')).toEqual({
      ok: false,
      reason: 'illegal_transition',
    });
    expect(checkIngestTransition('received', 'verifying', 'system')).toEqual({
      ok: false,
      reason: 'illegal_transition',
    });
    expect(checkIngestTransition('verifying', 'downloading', 'system')).toEqual({
      ok: false,
      reason: 'illegal_transition',
    });
  });

  it('mismo estado ⇒ same_state (un reintento no es un avance)', () => {
    expect(checkIngestTransition('downloading', 'downloading', 'system')).toEqual({
      ok: false,
      reason: 'same_state',
    });
  });

  it('estado o actor desconocido ⇒ rechazo (fail-closed sobre datos de Firestore)', () => {
    expect(checkIngestTransition('received', 'PAID' as AttachmentIngestState, 'system')).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
    expect(
      checkIngestTransition('unclassified' as AttachmentIngestState, 'stored', 'system'),
    ).toEqual({ ok: false, reason: 'unknown_state' });
    expect(checkIngestTransition('received', 'downloading', 'bot' as never)).toEqual({
      ok: false,
      reason: 'unknown_actor',
    });
  });

  it('el estado inicial es `received` y tiene salidas', () => {
    expect(ATTACHMENT_INITIAL_INGEST_STATE).toBe('received');
    expect(nextIngestStates('received')).toEqual(['downloading', 'rejected']);
    expect(ingestTransitionActors('received', 'downloading')).toEqual(['system']);
    expect(ingestTransitionActors('stored', 'received')).toEqual([]);
  });

  it('la tabla cubre exactamente los estados declarados', () => {
    expect(Object.keys(ATTACHMENT_INGEST_TRANSITIONS).sort()).toEqual(
      [...ATTACHMENT_INGEST_STATE].sort(),
    );
  });
});

describe('eje CLASIFICACIÓN — el pago siempre es humano', () => {
  it('el gate determinístico (system) puede proponer candidato o dejar medio normal', () => {
    expect(canClassificationTransition('unclassified', 'generic_media', 'system')).toBe(true);
    expect(canClassificationTransition('unclassified', 'payment_receipt_candidate', 'system')).toBe(
      true,
    );
  });

  it('SOLO un humano vincula un comprobante: system es rechazado explícitamente', () => {
    expect(
      checkClassificationTransition('payment_receipt_candidate', 'payment_receipt_linked', 'human'),
    ).toEqual({ ok: true });
    expect(
      checkClassificationTransition('payment_receipt_candidate', 'payment_receipt_linked', 'system'),
    ).toEqual({ ok: false, reason: 'actor_not_allowed' });
    expect(
      classificationTransitionActors('payment_receipt_candidate', 'payment_receipt_linked'),
    ).toEqual(['human']);
  });

  it('el sistema NO puede re-proponer un generic_media como candidato', () => {
    expect(checkClassificationTransition('generic_media', 'payment_receipt_candidate', 'system')).toEqual(
      { ok: false, reason: 'actor_not_allowed' },
    );
    expect(canClassificationTransition('generic_media', 'payment_receipt_candidate', 'human')).toBe(
      true,
    );
  });

  it('degradar es seguro: candidato→generic_media lo pueden hacer los dos', () => {
    expect(canClassificationTransition('payment_receipt_candidate', 'generic_media', 'system')).toBe(
      true,
    );
    expect(canClassificationTransition('payment_receipt_candidate', 'generic_media', 'human')).toBe(
      true,
    );
  });

  it('desmarcar un comprobante vinculado es SOLO humano y solo hacia generic_media', () => {
    expect(canClassificationTransition('payment_receipt_linked', 'generic_media', 'human')).toBe(
      true,
    );
    expect(canClassificationTransition('payment_receipt_linked', 'generic_media', 'system')).toBe(
      false,
    );
    expect(
      checkClassificationTransition(
        'payment_receipt_linked',
        'payment_receipt_candidate',
        'human',
      ),
    ).toEqual({ ok: false, reason: 'illegal_transition' });
  });

  it('no se puede saltar de unclassified/generic_media directo a linked', () => {
    for (const from of ['unclassified', 'generic_media'] as AttachmentClassification[]) {
      for (const actor of ['system', 'human'] as const) {
        expect(canClassificationTransition(from, 'payment_receipt_linked', actor)).toBe(false);
      }
    }
  });

  it('rejected solo lo pone el sistema desde unclassified y es terminal', () => {
    expect(canClassificationTransition('unclassified', 'rejected', 'system')).toBe(true);
    expect(checkClassificationTransition('unclassified', 'rejected', 'human')).toEqual({
      ok: false,
      reason: 'actor_not_allowed',
    });
    expect(isTerminalClassification('rejected')).toBe(true);
    expect(nextClassifications('rejected')).toEqual([]);
    expect(canClassificationTransition('generic_media', 'rejected', 'system')).toBe(false);
  });

  it('la clasificación inicial es `unclassified` y la tabla cubre los valores declarados', () => {
    expect(ATTACHMENT_INITIAL_CLASSIFICATION).toBe('unclassified');
    expect(Object.keys(ATTACHMENT_CLASSIFICATION_TRANSITIONS).sort()).toEqual(
      [...ATTACHMENT_CLASSIFICATION].sort(),
    );
  });
});

describe('guards auxiliares', () => {
  it('isAttachmentStored / isPaymentRelatedClassification', () => {
    expect(isAttachmentStored('stored')).toBe(true);
    expect(isAttachmentStored('verifying')).toBe(false);
    expect(isPaymentRelatedClassification('payment_receipt_candidate')).toBe(true);
    expect(isPaymentRelatedClassification('payment_receipt_linked')).toBe(true);
    expect(isPaymentRelatedClassification('generic_media')).toBe(false);
    expect(isPaymentRelatedClassification('unclassified')).toBe(false);
  });

  it('type guards rechazan basura', () => {
    expect(isAttachmentIngestState('stored')).toBe(true);
    expect(isAttachmentIngestState('STORED')).toBe(false);
    expect(isAttachmentIngestState(null)).toBe(false);
    expect(isAttachmentClassification('generic_media')).toBe(true);
    expect(isAttachmentClassification(42)).toBe(false);
    expect(isAttachmentActor('human')).toBe(true);
    expect(isAttachmentActor('seller')).toBe(false);
    expect(isAttachmentActor(undefined)).toBe(false);
  });
});
