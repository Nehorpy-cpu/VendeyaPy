import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RECEIPT_GATE_CONFIG,
  RECEIPT_GATE_DEFAULT_MAX_BYTES,
  RECEIPT_GATE_DEFAULT_WINDOW_MS,
  RECEIPT_GATE_MAX_WINDOW_MS,
  RECEIPT_GATE_MIN_WINDOW_MS,
  decideMarkAsReceipt,
  decideUnmarkReceipt,
  evaluateReceiptContext,
  evaluateReceiptFile,
  evaluateReceiptGate,
  mergeReceiptGateWithIngest,
  normalizeReceiptGateConfig,
  type ReceiptContextInput,
  type ReceiptGateAttachmentFacts,
  type ReceiptGateInput,
  type ReceiptMarkOrderFacts,
} from './receiptGate.js';
import type { AttachmentClassification, AttachmentIngestState, OrderStatus } from '@vpw/shared';

/**
 * ADR-0016 §4/§5 — El gate del comprobante. Los 9 escenarios de la etapa A del programa:
 * el camino feliz y las OCHO formas en que una imagen deja de ser comprobante.
 *
 * Invariante global de todo el archivo: NINGÚN camino produce `PAID`.
 */
const NOW = 1_700_000_000_000;
const TENANT = 'tnt_demo';
const CLIENTE = '595981000111';
const OTRO_CLIENTE = '595981999888';
const ATT = 'att_0123456789abcdef01234567';

const attachment = (over: Partial<ReceiptGateAttachmentFacts> = {}): ReceiptGateAttachmentFacts => ({
  attachmentId: ATT,
  tenantId: TENANT,
  customerId: CLIENTE,
  ingestState: 'stored' as AttachmentIngestState,
  classification: 'unclassified' as AttachmentClassification,
  orderCandidateId: null,
  mimeVerified: 'image/jpeg',
  bytes: 120_000,
  purgedAtMs: null,
  ...over,
});

const order = (
  id: string,
  status: OrderStatus,
  over: Partial<ReceiptMarkOrderFacts> = {},
): ReceiptMarkOrderFacts => ({
  orderId: id,
  customerId: CLIENTE,
  status,
  createdAtMs: NOW - 60_000,
  linkedAttachmentIds: [],
  linkedReceiptIds: [],
  statusDrivenBy: null,
  ...over,
});

const input = (over: Partial<ReceiptGateInput> = {}): ReceiptGateInput => ({
  tenantId: TENANT,
  customerId: CLIENTE,
  nowMs: NOW,
  attachment: attachment(),
  session: { awaitingPaymentDeclared: true, pendingOrderId: 'ord_1' },
  candidateOrders: [order('ord_1', 'PENDING_PAYMENT')],
  config: DEFAULT_RECEIPT_GATE_CONFIG,
  ...over,
});

describe('receiptGate — los 9 escenarios de la etapa A', () => {
  it('1) camino feliz: contexto declarado + un pedido admisible + ventana + archivo verificado ⇒ candidato', () => {
    const r = evaluateReceiptGate(input());
    expect(r).toEqual({
      ok: true,
      classification: 'payment_receipt_candidate',
      orderId: 'ord_1',
      confidence: 1,
      alreadyLinked: false,
    });
  });

  it('2) SIN contexto explícito de pago (foto de producto) ⇒ generic_media, el pedido no se toca', () => {
    const r = evaluateReceiptGate(input({ session: { awaitingPaymentDeclared: false, pendingOrderId: 'ord_1' } }));
    expect(r).toEqual({ ok: false, classification: 'generic_media', reason: 'no_explicit_payment_context' });
  });

  it('3) el pendingOrderId apunta a un pedido de OTRO cliente ⇒ generic_media (el bug de la auditoría)', () => {
    const r = evaluateReceiptGate(
      input({ candidateOrders: [order('ord_1', 'PENDING_PAYMENT', { customerId: OTRO_CLIENTE })] }),
    );
    expect(r).toEqual({ ok: false, classification: 'generic_media', reason: 'order_customer_mismatch' });
  });

  it('4) sin ningún pedido admisible ⇒ generic_media', () => {
    const r = evaluateReceiptGate(input({ candidateOrders: [], session: { awaitingPaymentDeclared: true, pendingOrderId: null } }));
    expect(r).toEqual({ ok: false, classification: 'generic_media', reason: 'no_admissible_order' });
  });

  it('5) dos PENDING_PAYMENT y sin declaración vigente ⇒ ambigüedad ⇒ generic_media', () => {
    const r = evaluateReceiptGate(
      input({
        session: { awaitingPaymentDeclared: true, pendingOrderId: null },
        candidateOrders: [order('ord_1', 'PENDING_PAYMENT'), order('ord_2', 'PENDING_PAYMENT')],
      }),
    );
    expect(r).toEqual({ ok: false, classification: 'generic_media', reason: 'ambiguous_orders' });
  });

  it('6) pedido ya PAID (o en la cadena operativa) ⇒ generic_media, nunca se re-abre', () => {
    for (const status of ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'] as OrderStatus[]) {
      const r = evaluateReceiptGate(
        input({
          session: { awaitingPaymentDeclared: true, pendingOrderId: 'ord_1' },
          candidateOrders: [order('ord_1', status)],
        }),
      );
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ classification: 'generic_media', reason: 'order_already_paid' });
    }
  });

  it('7) fuera de la ventana temporal del tenant ⇒ generic_media', () => {
    const viejo = order('ord_1', 'PENDING_PAYMENT', { createdAtMs: NOW - RECEIPT_GATE_DEFAULT_WINDOW_MS - 1 });
    expect(evaluateReceiptGate(input({ candidateOrders: [viejo] }))).toEqual({
      ok: false,
      classification: 'generic_media',
      reason: 'outside_time_window',
    });
    // La ventana es configuración por tenant: con una más larga, el MISMO caso pasa.
    expect(
      evaluateReceiptGate(
        input({
          candidateOrders: [viejo],
          config: normalizeReceiptGateConfig({ windowMinutes: 60 * 48 }),
        }),
      ).ok,
    ).toBe(true);
  });

  it('8) el archivo no está `stored` (rechazado / descarga fallida) ⇒ generic_media', () => {
    for (const ingestState of ['received', 'downloading', 'verifying', 'rejected', 'download_failed'] as AttachmentIngestState[]) {
      expect(evaluateReceiptGate(input({ attachment: attachment({ ingestState }) }))).toEqual({
        ok: false,
        classification: 'generic_media',
        reason: 'attachment_not_stored',
      });
    }
  });

  it('9) MIME verificado no admitido o tamaño fuera de límite ⇒ generic_media', () => {
    expect(evaluateReceiptGate(input({ attachment: attachment({ mimeVerified: 'image/svg+xml' }) }))).toMatchObject({
      reason: 'mime_not_allowed',
    });
    expect(evaluateReceiptGate(input({ attachment: attachment({ mimeVerified: null }) }))).toMatchObject({
      reason: 'mime_not_allowed',
    });
    expect(
      evaluateReceiptGate(input({ attachment: attachment({ bytes: RECEIPT_GATE_DEFAULT_MAX_BYTES + 1 }) })),
    ).toMatchObject({ reason: 'size_not_allowed' });
    expect(evaluateReceiptGate(input({ attachment: attachment({ bytes: 0 }) }))).toMatchObject({
      reason: 'size_not_allowed',
    });
  });

  it('ningún camino del gate produce PAID ni toca el estado del pedido', () => {
    const decisiones = [
      evaluateReceiptGate(input()),
      evaluateReceiptGate(input({ session: { awaitingPaymentDeclared: false, pendingOrderId: null } })),
    ];
    for (const d of decisiones) {
      expect(JSON.stringify(d)).not.toMatch(/PAID/);
      expect(d.ok ? d.classification : d.classification).not.toBe('payment_receipt_linked');
    }
  });
});

describe('receiptGate — aislamiento e idempotencia', () => {
  it('adjunto de otro tenant o de otro cliente ⇒ ni se evalúa', () => {
    expect(evaluateReceiptGate(input({ attachment: attachment({ tenantId: 'tnt_otro' }) }))).toMatchObject({
      reason: 'tenant_mismatch',
    });
    expect(evaluateReceiptGate(input({ attachment: attachment({ customerId: OTRO_CLIENTE }) }))).toMatchObject({
      reason: 'customer_mismatch',
    });
  });

  it('idempotencia (tenantId, attachmentId): ya propuesto ⇒ misma respuesta aunque la ventana venza', () => {
    const yaCandidato = attachment({ classification: 'payment_receipt_candidate', orderCandidateId: 'ord_1' });
    const r = evaluateReceiptGate(input({ attachment: yaCandidato, nowMs: NOW + RECEIPT_GATE_MAX_WINDOW_MS }));
    expect(r).toEqual({
      ok: true,
      classification: 'payment_receipt_candidate',
      orderId: 'ord_1',
      confidence: 1,
      alreadyLinked: true,
    });
  });

  it('idempotencia (orderId, attachmentId): el pedido ya tiene el adjunto ⇒ alreadyLinked', () => {
    const r = evaluateReceiptGate(
      input({ candidateOrders: [order('ord_1', 'PENDING_PAYMENT', { linkedAttachmentIds: [ATT] })] }),
    );
    expect(r).toMatchObject({ ok: true, alreadyLinked: true, orderId: 'ord_1' });
  });

  it('el gate automático NO pisa lo que ya decidió una persona', () => {
    expect(
      evaluateReceiptGate(input({ attachment: attachment({ classification: 'payment_receipt_linked', orderCandidateId: 'ord_1' }) })),
    ).toMatchObject({ reason: 'classification_not_open', classification: 'generic_media' });
    expect(evaluateReceiptGate(input({ attachment: attachment({ classification: 'generic_media' }) }))).toMatchObject({
      reason: 'classification_not_open',
    });
  });
});

describe('receiptGate — contexto y ventana', () => {
  const ctx = (over: Partial<ReceiptContextInput> = {}) =>
    evaluateReceiptContext({
      tenantId: TENANT,
      customerId: CLIENTE,
      nowMs: NOW,
      session: { awaitingPaymentDeclared: true, pendingOrderId: 'ord_1' },
      candidateOrders: [order('ord_1', 'PENDING_PAYMENT')],
      config: DEFAULT_RECEIPT_GATE_CONFIG,
      ...over,
    });

  /**
   * DISCRIMINANTE B2. El puntero de sesión NO exime del chequeo de ambigüedad. Vector real: el
   * cliente hace checkout de A y después de B — el puntero se pisa y queda en el último—, así que
   * "la declaración desambigua" hacía caer el comprobante en el pedido que el puntero apuntara,
   * no en el que el cliente pagó. ADR-0016 §4: "exactamente un pedido admisible" + "cero
   * ambigüedad". Si esta línea se relaja (volver a preferir el declarado), el test se pone rojo.
   */
  it('el pendingOrderId NO desambigua: con dos pedidos admisibles se rechaza aunque la sesión declare uno', () => {
    for (const declarado of ['ord_1', 'ord_2', null]) {
      const r = ctx({
        session: { awaitingPaymentDeclared: true, pendingOrderId: declarado },
        candidateOrders: [order('ord_1', 'PENDING_PAYMENT'), order('ord_2', 'PENDING_PAYMENT')],
      });
      expect(r).toEqual({ ok: false, reason: 'ambiguous_orders' });
    }
  });

  it('el puntero declarado tampoco desambigua entre estados admisibles distintos', () => {
    const r = ctx({
      session: { awaitingPaymentDeclared: true, pendingOrderId: 'ord_1' },
      candidateOrders: [order('ord_1', 'PENDING_VERIFICATION'), order('ord_2', 'PENDING_PAYMENT')],
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_orders' });
  });

  it('con UN solo pedido admisible el puntero declarado sigue resolviendo al mismo pedido', () => {
    expect(ctx({ candidateOrders: [order('ord_1', 'PENDING_PAYMENT'), order('ord_2', 'PAID')] })).toEqual({
      ok: true,
      orderId: 'ord_1',
    });
  });

  it('PENDING_VERIFICATION declarado sigue admitiendo un segundo envío (multi-adjunto)', () => {
    expect(ctx({ candidateOrders: [order('ord_1', 'PENDING_VERIFICATION')] })).toEqual({ ok: true, orderId: 'ord_1' });
  });

  it('puntero VIEJO (pedido ya pagado) ⇒ cae a la búsqueda por cliente, sin adivinar', () => {
    const r = ctx({
      session: { awaitingPaymentDeclared: true, pendingOrderId: 'ord_viejo' },
      candidateOrders: [order('ord_viejo', 'PAID'), order('ord_nuevo', 'PENDING_PAYMENT')],
    });
    expect(r).toEqual({ ok: true, orderId: 'ord_nuevo' });
  });

  it('pedidos CANCELLED/REFUNDED no son admisibles', () => {
    expect(ctx({ candidateOrders: [order('ord_1', 'CANCELLED')] })).toEqual({
      ok: false,
      reason: 'order_not_admissible',
    });
  });

  it('tolera desfasaje de reloj chico hacia el futuro, no una fecha absurda', () => {
    expect(ctx({ candidateOrders: [order('ord_1', 'PENDING_PAYMENT', { createdAtMs: NOW + 30_000 })] }).ok).toBe(true);
    expect(ctx({ candidateOrders: [order('ord_1', 'PENDING_PAYMENT', { createdAtMs: NOW + 86_400_000 })] })).toEqual({
      ok: false,
      reason: 'outside_time_window',
    });
  });
});

describe('receiptGate — normalizeReceiptGateConfig (config por tenant, fail-closed)', () => {
  it('doc vacío o corrupto ⇒ defaults', () => {
    expect(normalizeReceiptGateConfig(undefined)).toEqual(DEFAULT_RECEIPT_GATE_CONFIG);
    expect(normalizeReceiptGateConfig({ windowMinutes: 'mucho', maxBytes: -3 })).toEqual(DEFAULT_RECEIPT_GATE_CONFIG);
  });

  it('la ventana se acota entre el piso y el techo duros', () => {
    expect(normalizeReceiptGateConfig({ windowMinutes: 0.1 }).windowMs).toBe(RECEIPT_GATE_MIN_WINDOW_MS);
    expect(normalizeReceiptGateConfig({ windowMinutes: 60 * 24 * 365 }).windowMs).toBe(RECEIPT_GATE_MAX_WINDOW_MS);
  });

  it('un tenant puede RESTRINGIR formatos pero jamás habilitar uno fuera de la whitelist', () => {
    expect(normalizeReceiptGateConfig({ allowedMimeTypes: ['image/jpeg'] }).allowedMimeTypes).toEqual(['image/jpeg']);
    expect(normalizeReceiptGateConfig({ allowedMimeTypes: ['image/svg+xml', 'text/html'] }).allowedMimeTypes).toEqual(
      DEFAULT_RECEIPT_GATE_CONFIG.allowedMimeTypes,
    );
  });

  it('PDF está admitido: las apps bancarias mandan el comprobante así', () => {
    expect(
      evaluateReceiptFile(
        { ingestState: 'stored', mimeVerified: 'application/pdf', bytes: 900, purgedAtMs: null },
        DEFAULT_RECEIPT_GATE_CONFIG,
      ),
    ).toEqual({ ok: true });
  });

  /**
   * DISCRIMINANTE B4 (lado gate). La purga borra los BYTES y deja el documento con
   * `ingestState: 'stored'` para que el chat siga mostrando que hubo un archivo. Si el gate mira
   * solo `stored`, propone como comprobante algo que ya nadie puede abrir.
   */
  it('un adjunto PURGADO no pasa la verificación aunque siga diciendo `stored`', () => {
    expect(
      evaluateReceiptFile(
        { ingestState: 'stored', mimeVerified: 'image/jpeg', bytes: 900, purgedAtMs: NOW - 1_000 },
        DEFAULT_RECEIPT_GATE_CONFIG,
      ),
    ).toEqual({ ok: false, reason: 'attachment_purged' });
    expect(evaluateReceiptGate(input({ attachment: attachment({ purgedAtMs: NOW - 1_000 }) }))).toEqual({
      ok: false,
      classification: 'generic_media',
      reason: 'attachment_purged',
    });
  });
});

describe('receiptGate — marcar (acción HUMANA, ADR-0016 §5)', () => {
  it('marcar un candidato de un pedido PENDING_PAYMENT ⇒ pasa a PENDING_VERIFICATION (nunca PAID)', () => {
    const d = decideMarkAsReceipt({
      tenantId: TENANT,
      attachment: attachment({ classification: 'payment_receipt_candidate', orderCandidateId: 'ord_1' }),
      order: order('ord_1', 'PENDING_PAYMENT'),
    });
    expect(d).toEqual({
      ok: true,
      alreadyMarked: false,
      classificationPath: ['payment_receipt_linked'],
      moveOrderToPendingVerification: true,
    });
  });

  it('marcar un generic_media recorre el camino legal de la máquina de estados', () => {
    const d = decideMarkAsReceipt({
      tenantId: TENANT,
      attachment: attachment({ classification: 'generic_media' }),
      order: order('ord_1', 'PENDING_PAYMENT'),
    });
    expect(d).toMatchObject({ ok: true, classificationPath: ['payment_receipt_candidate', 'payment_receipt_linked'] });
  });

  it('un segundo adjunto sobre un pedido YA en verificación no vuelve a mover el estado', () => {
    const d = decideMarkAsReceipt({
      tenantId: TENANT,
      attachment: attachment({ classification: 'payment_receipt_candidate' }),
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: 'att_otro' }),
    });
    expect(d).toMatchObject({ ok: true, moveOrderToPendingVerification: false });
  });

  it('marcar es idempotente contra el MISMO pedido y se rechaza contra otro', () => {
    const linked = attachment({ classification: 'payment_receipt_linked', orderCandidateId: 'ord_1' });
    expect(decideMarkAsReceipt({ tenantId: TENANT, attachment: linked, order: order('ord_1', 'PENDING_VERIFICATION') })).toMatchObject({
      ok: true,
      alreadyMarked: true,
      moveOrderToPendingVerification: false,
    });
    expect(decideMarkAsReceipt({ tenantId: TENANT, attachment: linked, order: order('ord_2', 'PENDING_PAYMENT') })).toEqual({
      ok: false,
      reason: 'linked_to_another_order',
    });
  });

  it('ILEGAL: pedido pagado, terminal, de otro cliente, de otro tenant o archivo sin bytes', () => {
    const base = attachment({ classification: 'payment_receipt_candidate' });
    expect(decideMarkAsReceipt({ tenantId: TENANT, attachment: base, order: order('ord_1', 'PAID') })).toEqual({
      ok: false,
      reason: 'order_already_paid',
    });
    expect(decideMarkAsReceipt({ tenantId: TENANT, attachment: base, order: order('ord_1', 'CANCELLED') })).toEqual({
      ok: false,
      reason: 'order_not_admissible',
    });
    expect(
      decideMarkAsReceipt({ tenantId: TENANT, attachment: base, order: order('ord_1', 'PENDING_PAYMENT', { customerId: OTRO_CLIENTE }) }),
    ).toEqual({ ok: false, reason: 'order_customer_mismatch' });
    expect(decideMarkAsReceipt({ tenantId: 'tnt_otro', attachment: base, order: order('ord_1', 'PENDING_PAYMENT') })).toEqual({
      ok: false,
      reason: 'tenant_mismatch',
    });
    expect(
      decideMarkAsReceipt({
        tenantId: TENANT,
        attachment: attachment({ classification: 'payment_receipt_candidate', ingestState: 'download_failed' }),
        order: order('ord_1', 'PENDING_PAYMENT'),
      }),
    ).toEqual({ ok: false, reason: 'attachment_not_stored' });
    expect(
      decideMarkAsReceipt({
        tenantId: TENANT,
        attachment: attachment({ classification: 'rejected' }),
        order: order('ord_1', 'PENDING_PAYMENT'),
      }),
    ).toEqual({ ok: false, reason: 'classification_terminal' });
  });

  /**
   * DISCRIMINANTE B4 (lado humano). Un adjunto cuyos bytes ya borró la purga conserva
   * `ingestState: 'stored'`: si el único chequeo es ése, un vendedor puede vincular como
   * comprobante un archivo que no existe y el pedido pasa a PENDING_VERIFICATION sin evidencia.
   */
  it('un adjunto PURGADO no puede vincularse aunque `ingestState` siga en `stored`', () => {
    expect(
      decideMarkAsReceipt({
        tenantId: TENANT,
        attachment: attachment({ classification: 'payment_receipt_candidate', purgedAtMs: NOW - 5_000 }),
        order: order('ord_1', 'PENDING_PAYMENT'),
      }),
    ).toEqual({ ok: false, reason: 'attachment_purged' });
  });

  it('marcar NUNCA propone PAID como destino', () => {
    const d = decideMarkAsReceipt({
      tenantId: TENANT,
      attachment: attachment({ classification: 'payment_receipt_candidate' }),
      order: order('ord_1', 'PENDING_PAYMENT'),
    });
    expect(JSON.stringify(d)).not.toMatch(/PAID/);
  });
});

describe('receiptGate — desmarcar (acción HUMANA)', () => {
  const linked = attachment({ classification: 'payment_receipt_linked', orderCandidateId: 'ord_1' });

  it('desmarcar el ÚNICO comprobante vinculado revierte a PENDING_PAYMENT y preserva el archivo', () => {
    const d = decideUnmarkReceipt({
      tenantId: TENANT,
      attachment: linked,
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: ATT, linkedReceiptIds: [ATT] }),
    });
    expect(d).toEqual({ ok: true, revertOrderToPendingPayment: true, nextStatusDrivenBy: null });
  });

  it('si OTRO adjunto figura como origen del estado, no se desmarca a ciegas', () => {
    expect(
      decideUnmarkReceipt({
        tenantId: TENANT,
        attachment: linked,
        order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: 'att_otro' }),
      }),
    ).toEqual({ ok: false, reason: 'other_evidence_drives_status' });
  });

  /**
   * DISCRIMINANTE B3 — DEADLOCK del puntero nulo. Vector real: el pedido llegó a
   * `PENDING_VERIFICATION` por el flujo legacy/dev (`submitComprobante`), así que cuando el
   * vendedor marca un adjunto NO hay cambio de estado y `statusDrivenBy` queda sin definir. Con la
   * regla vieja, desmarcar quedaba bloqueado PARA SIEMPRE con un mensaje que mandaba a desmarcar
   * "el otro comprobante" que no existe: el adjunto quedaba como evidencia de pago imborrable.
   *
   * Lo que sí se conserva: el pedido NO se revierte, porque este camino no produjo ese estado.
   */
  it('puntero NULO (estado producido por el flujo legacy): se desmarca y el pedido NO se revierte', () => {
    const d = decideUnmarkReceipt({
      tenantId: TENANT,
      attachment: linked,
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: null, linkedReceiptIds: [ATT] }),
    });
    expect(d).toEqual({ ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: null });
  });

  it('puntero NULO sin vinculados registrados: tampoco traba (el adjunto igual se libera)', () => {
    const d = decideUnmarkReceipt({
      tenantId: TENANT,
      attachment: linked,
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: null, linkedReceiptIds: [] }),
    });
    expect(d).toEqual({ ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: null });
  });

  /**
   * DISCRIMINANTE B1. Vector: el cliente manda DOS archivos, el vendedor marca A (el pedido pasa
   * a PENDING_VERIFICATION con el puntero en A) y después marca B (como ya estaba en
   * PENDING_VERIFICATION el puntero NO se movió). Con la regla vieja —"revierto si el puntero soy
   * yo"— desmarcar A devolvía el pedido a PENDING_PAYMENT con B todavía vinculado por una persona:
   * se borraba una decisión humana que nadie revocó. La regla correcta mira la LISTA.
   */
  it('con DOS comprobantes vinculados, desmarcar el que figura como origen NO revierte el pedido', () => {
    const OTRO = 'att_ffffffffffffffffffffffff';
    const d = decideUnmarkReceipt({
      tenantId: TENANT,
      attachment: linked,
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: ATT, linkedReceiptIds: [ATT, OTRO] }),
    });
    // El estado sigue sostenido por el otro comprobante: el puntero se TRASPASA, no se revierte.
    expect(d).toEqual({ ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: OTRO });
  });

  it('desmarcar un vinculado que NO es el origen deja el estado y el puntero intactos', () => {
    const OTRO = 'att_ffffffffffffffffffffffff';
    const d = decideUnmarkReceipt({
      tenantId: TENANT,
      attachment: linked,
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: OTRO, linkedReceiptIds: [OTRO, ATT] }),
    });
    expect(d).toEqual({ ok: true, revertOrderToPendingPayment: false, nextStatusDrivenBy: OTRO });
  });

  it('al vaciarse la lista de vinculados recién ahí se revierte (dos desmarcados seguidos)', () => {
    const OTRO = 'att_ffffffffffffffffffffffff';
    const segundo = decideUnmarkReceipt({
      tenantId: TENANT,
      attachment: attachment({ attachmentId: OTRO, classification: 'payment_receipt_linked', orderCandidateId: 'ord_1' }),
      order: order('ord_1', 'PENDING_VERIFICATION', { statusDrivenBy: OTRO, linkedReceiptIds: [OTRO] }),
    });
    expect(segundo).toEqual({ ok: true, revertOrderToPendingPayment: true, nextStatusDrivenBy: null });
  });

  it('pedido PAID o terminal ⇒ no se desmarca (evidencia de un pedido cerrado)', () => {
    expect(decideUnmarkReceipt({ tenantId: TENANT, attachment: linked, order: order('ord_1', 'PAID') })).toEqual({
      ok: false,
      reason: 'order_already_paid',
    });
    for (const status of ['REFUNDED', 'CANCELLED', 'DELIVERED'] as OrderStatus[]) {
      const d = decideUnmarkReceipt({ tenantId: TENANT, attachment: linked, order: order('ord_1', status) });
      expect(d.ok).toBe(false);
    }
  });

  it('lo que no está vinculado (o está vinculado a otro pedido) no se desmarca', () => {
    expect(
      decideUnmarkReceipt({ tenantId: TENANT, attachment: attachment({ classification: 'generic_media' }), order: order('ord_1', 'PENDING_PAYMENT') }),
    ).toEqual({ ok: false, reason: 'not_linked' });
    expect(decideUnmarkReceipt({ tenantId: TENANT, attachment: linked, order: order('ord_2', 'PENDING_VERIFICATION') })).toEqual({
      ok: false,
      reason: 'linked_to_another_order',
    });
  });
});

/**
 * DISCRIMINANTE B4 — la MISMA decisión no puede vivir en dos documentos que se contradigan.
 * "Qué archivos admite este tenant" lo declara la config de INGESTA; el gate no puede ser más
 * permisivo que ella, porque prometería un formato o un tamaño que jamás va a llegar al bucket.
 */
describe('receiptGate — composición con los límites de INGESTA (una sola decisión)', () => {
  const ingest = (over: Partial<{ maxBytes: number; allowedMimeTypes: readonly string[] }> = {}) => ({
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as readonly string[],
    ...over,
  });

  it('el gate NUNCA amplía lo que la ingesta admite (formatos y bytes)', () => {
    const gate = normalizeReceiptGateConfig({ maxBytes: 8 * 1024 * 1024 });
    const efectiva = mergeReceiptGateWithIngest(gate, ingest({ maxBytes: 1_000_000, allowedMimeTypes: ['image/jpeg'] }));

    expect(efectiva.allowedMimeTypes).toEqual(['image/jpeg']);
    expect(efectiva.maxBytes).toBe(1_000_000);
    // La ventana es del gate y solo del gate: la ingesta no tiene una.
    expect(efectiva.windowMs).toBe(gate.windowMs);
  });

  it('una restricción PROPIA del gate se sigue respetando (restringir de más es seguro)', () => {
    const gate = normalizeReceiptGateConfig({ allowedMimeTypes: ['image/jpeg'], maxBytes: 500_000 });
    const efectiva = mergeReceiptGateWithIngest(gate, ingest());

    expect(efectiva.allowedMimeTypes).toEqual(['image/jpeg']);
    expect(efectiva.maxBytes).toBe(500_000);
  });

  it('configs CONTRADICTORIAS (intersección vacía) ⇒ no se propone nada, no se cae al default', () => {
    const gate = normalizeReceiptGateConfig({ allowedMimeTypes: ['application/pdf'] });
    const efectiva = mergeReceiptGateWithIngest(gate, ingest({ allowedMimeTypes: ['image/jpeg'] }));

    expect(efectiva.allowedMimeTypes).toEqual([]);
    // Y el archivo, con esa config, queda como MEDIO NORMAL: se guarda y se ve, no se pierde.
    expect(evaluateReceiptFile(attachment({ mimeVerified: 'application/pdf' }), efectiva)).toEqual({
      ok: false,
      reason: 'mime_not_allowed',
    });
  });

  it('ningún MIME admitido por el gate efectivo queda fuera de la ingesta (invariante)', () => {
    const combinaciones = [
      { gate: {}, ingest: {} },
      { gate: { allowedMimeTypes: ['image/jpeg', 'application/pdf'] }, ingest: { allowedMimeTypes: ['application/pdf'] } },
      { gate: { allowedMimeTypes: ['image/png'] }, ingest: {} },
      { gate: { maxBytes: 1 }, ingest: { maxBytes: 9_000_000 } },
      { gate: {}, ingest: { allowedMimeTypes: ['image/webp'], maxBytes: 70_000 } },
    ];
    for (const c of combinaciones) {
      const limites = ingest(c.ingest);
      const efectiva = mergeReceiptGateWithIngest(normalizeReceiptGateConfig(c.gate), limites);
      for (const mime of efectiva.allowedMimeTypes) expect(limites.allowedMimeTypes).toContain(mime);
      expect(efectiva.maxBytes).toBeLessThanOrEqual(limites.maxBytes);
    }
  });
});
