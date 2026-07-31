/**
 * Helpers puros de adjuntos (ADR-0016 · Área D).
 * Lo que se prueba acá es la LEGALIDAD de lo que la UI ofrece: qué se muestra, qué se puede
 * marcar, qué se puede desmarcar y qué se dice cuando algo falla.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Attachment, AttachmentClassification, AttachmentIngestState, Order, OrderStatus } from '@vpw/shared';

/**
 * Firestore falso: devuelve documentos CRUDOS (con `storage.path` adentro) para poder afirmar que
 * la lectura del panel proyecta y que ningún doc crudo llega al estado de la app.
 */
const fakeFirestore = vi.hoisted(() => ({ docs: [] as Array<Record<string, unknown>> }));
vi.mock('./firebase', () => ({ firebaseDb: () => ({}), firebaseFunctions: () => ({}) }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}),
  query: (...a: unknown[]) => a,
  where: (...a: unknown[]) => a,
  limit: (n: number) => n,
  getDocs: async () => ({ docs: fakeFirestore.docs.map((d) => ({ data: () => d })) }),
}));

import {
  attachmentAltText,
  attachmentDisplayName,
  attachmentErrorHint,
  attachmentTypeLabel,
  attachmentUiState,
  autorClasificacion,
  classificationLabel,
  formatAttachmentSize,
  indexAttachments,
  listConversationAttachments,
  pedidosElegiblesParaComprobante,
  puedeClasificarComprobantes,
  puedeDesmarcarComprobante,
  puedeMarcarComprobante,
  toPanelAttachment,
} from './attachments';

const ts = (ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms }) as unknown as Attachment['createdAt'];

function att(over: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: 'att_' + 'a'.repeat(24),
    tenantId: 'tnt_1',
    customerId: '595981000000',
    conversationId: '595981000000',
    messageId: 'msg_1',
    providerMessageId: 'pmid_' + 'b'.repeat(24),
    channel: 'whatsapp',
    class: 'image',
    direction: 'in',
    author: 'customer',
    ingestState: 'stored',
    classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: ts(1) },
    caption: '',
    filename: null,
    mime: { declared: 'image/jpeg', verified: 'image/jpeg' },
    bytes: 2048,
    checksum: 'abc',
    storage: { path: 'tenants/tnt_1/attachments/aa/att_x' },
    orderCandidateId: null,
    retentionUntil: null,
    purgedAt: null,
    createdAt: ts(1),
    updatedAt: ts(1),
    lastError: null,
    ...over,
  } as Attachment;
}

function order(over: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    tenantId: 'tnt_1',
    customerId: '595981000000',
    status: 'PENDING_PAYMENT' as OrderStatus,
    items: [],
    totals: { subtotal: 100, discount: 0, total: 100, currency: 'PYG' },
    createdAt: ts(10),
    ...over,
  } as unknown as Order;
}

describe('proyección al panel: la ruta de Storage NO sale de Firestore', () => {
  const PATH = 'tenants/tnt_1/attachments/aa/att_ruta_secreta';
  const crudo = () =>
    ({
      ...att(),
      storage: { path: PATH },
      checksum: 'sha256-checksum-interno',
      providerMessageId: 'pmid_interno_hasheado',
      retentionUntil: ts(999),
      purgedAt: null,
    }) as unknown as Record<string, unknown>;

  /** Lo que la UI realmente consume. Si alguien agrega un campo, este test obliga a pensarlo. */
  const CAMPOS_UI = [
    'attachmentId',
    'bytes',
    'caption',
    'class',
    'classification',
    'createdAt',
    'customerId',
    'filename',
    'ingestState',
    'lastError',
    'mime',
    'orderCandidateId',
  ];

  it('toPanelAttachment construye un objeto NUEVO y el path no está en él', () => {
    const p = toPanelAttachment(crudo());
    expect(p).not.toBeNull();
    expect(Object.keys(p!).sort()).toEqual(CAMPOS_UI);
    expect(p).not.toHaveProperty('storage');
    const serializado = JSON.stringify(p);
    expect(serializado).not.toContain('tenants/');
    expect(serializado).not.toContain('att_ruta_secreta');
    expect(serializado).not.toContain('sha256-checksum-interno');
    expect(serializado).not.toContain('pmid_interno_hasheado');
    // Del MIME solo viaja el VERIFICADO: el declarado por el proveedor no tiene autoridad.
    expect(p!.mime).toEqual({ verified: 'image/jpeg' });
  });

  it('un documento sin `attachmentId` no se convierte en una tarjeta rota', () => {
    expect(toPanelAttachment(undefined)).toBeNull();
    expect(toPanelAttachment(null)).toBeNull();
    expect(toPanelAttachment({ storage: { path: PATH } })).toBeNull();
  });

  it('listConversationAttachments proyecta: ningún doc crudo llega al estado de la app', async () => {
    fakeFirestore.docs = [crudo(), { soyBasura: true, storage: { path: PATH } }];
    const lista = await listConversationAttachments('tnt_1', '595981000000');
    expect(lista).toHaveLength(1); // el doc sin attachmentId se descarta
    expect(lista[0]).not.toHaveProperty('storage');
    expect(JSON.stringify(lista)).not.toContain('tenants/');
    expect(JSON.stringify(lista)).not.toContain('att_ruta_secreta');
  });
});

describe('attachmentUiState — los tres estados que la burbuja tiene que saber pintar', () => {
  const casos: [AttachmentIngestState, string][] = [
    ['received', 'loading'],
    ['downloading', 'loading'],
    ['verifying', 'loading'],
    ['stored', 'ready'],
    ['rejected', 'error'],
    ['download_failed', 'error'],
  ];
  it.each(casos)('%s → %s', (ingestState, esperado) => {
    expect(attachmentUiState(att({ ingestState }))).toBe(esperado);
  });
});

describe('attachmentErrorHint — el motivo siempre dice qué hacer', () => {
  it('rechazado: pide reenviar en un formato admitido', () => {
    const t = attachmentErrorHint(att({ ingestState: 'rejected' }));
    expect(t).toMatch(/reenv/i);
    expect(t).toMatch(/JPG|PDF/);
  });
  it('descarga fallida: pide reenviar', () => {
    expect(attachmentErrorHint(att({ ingestState: 'download_failed' }))).toMatch(/reenv/i);
  });
});

describe('attachmentTypeLabel — la autoridad es el MIME VERIFICADO', () => {
  it('usa el verificado, no el declarado', () => {
    expect(attachmentTypeLabel(att({ mime: { declared: 'image/png', verified: 'application/pdf' } }))).toBe('PDF');
  });
  it('sin verificar NO muestra el declarado como si fuera cierto', () => {
    const label = attachmentTypeLabel(att({ mime: { declared: 'image/jpeg', verified: null } }));
    expect(label).toBe('Tipo sin verificar');
    expect(label).not.toContain('jpeg');
  });
});

describe('nombre, tamaño y alt', () => {
  it('sin filename usa un rótulo por clase', () => {
    expect(attachmentDisplayName(att({ class: 'image', filename: null }))).toBe('Imagen del cliente');
    expect(attachmentDisplayName(att({ class: 'document', filename: null }))).toBe('Documento del cliente');
    expect(attachmentDisplayName(att({ filename: 'transferencia.pdf' }))).toBe('transferencia.pdf');
  });
  it('tamaño desconocido no se inventa como 0', () => {
    expect(formatAttachmentSize(null)).toBe('Tamaño desconocido');
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('el alt describe el archivo e incluye el caption saneado', () => {
    expect(attachmentAltText(att({ caption: '' }))).toBe('Imagen enviada por el cliente');
    expect(attachmentAltText(att({ caption: 'ya pagué' }))).toContain('ya pagué');
  });
});

describe('puedeMarcarComprobante — roles del ADR y máquina de estados compartida', () => {
  it('solo OWNER, MANAGER y SELLER clasifican', () => {
    expect(puedeClasificarComprobantes('TENANT_OWNER')).toBe(true);
    expect(puedeClasificarComprobantes('TENANT_MANAGER')).toBe(true);
    expect(puedeClasificarComprobantes('SELLER')).toBe(true);
    expect(puedeClasificarComprobantes('TENANT_VIEWER')).toBe(false);
    expect(puedeClasificarComprobantes('PLATFORM_ADMIN')).toBe(false);
    expect(puedeClasificarComprobantes(null)).toBe(false);
  });

  it('un lector no puede marcar aunque el adjunto sea candidato', () => {
    const a = att({ classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: ts(1) } });
    expect(puedeMarcarComprobante(a, 'TENANT_VIEWER')).toBe(false);
  });

  it('sin bytes guardados no se puede marcar (no hay comprobante que vincular)', () => {
    const a = att({ ingestState: 'downloading' });
    expect(puedeMarcarComprobante(a, 'SELLER')).toBe(false);
  });

  const clasif: [AttachmentClassification, boolean][] = [
    ['unclassified', true],
    ['generic_media', true],
    ['payment_receipt_candidate', true],
    ['payment_receipt_linked', false], // ya vinculado: no se re-marca
    ['rejected', false], // terminal: no hay archivo que significar
  ];
  it.each(clasif)('clasificación %s → puede marcar: %s', (value, esperado) => {
    const a = att({ classification: { value, source: 'rule', confidence: 1, by: null, at: ts(1) } });
    expect(puedeMarcarComprobante(a, 'SELLER')).toBe(esperado);
  });
});

describe('puedeDesmarcarComprobante — solo cuando es legal', () => {
  const vinculado = att({
    classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_1', at: ts(2) },
    orderCandidateId: 'ord_1',
  });

  it('vinculado + pedido en verificación → sí', () => {
    expect(puedeDesmarcarComprobante(vinculado, order({ status: 'PENDING_VERIFICATION' }), 'TENANT_OWNER')).toBe(true);
  });
  it('pedido PAGADO → NO (desmarcar no puede borrar evidencia de un pago confirmado)', () => {
    expect(puedeDesmarcarComprobante(vinculado, order({ status: 'PAID' }), 'TENANT_OWNER')).toBe(false);
    expect(puedeDesmarcarComprobante(vinculado, order({ status: 'DELIVERED' }), 'TENANT_OWNER')).toBe(false);
  });
  it('sin el pedido a la vista → NO se ofrece', () => {
    expect(puedeDesmarcarComprobante(vinculado, null, 'TENANT_OWNER')).toBe(false);
  });
  it('un candidato NO se desmarca (nunca se marcó)', () => {
    const cand = att({ classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: ts(1) } });
    expect(puedeDesmarcarComprobante(cand, order({ status: 'PENDING_VERIFICATION' }), 'TENANT_OWNER')).toBe(false);
  });
});

describe('pedidosElegiblesParaComprobante — mismo cliente y estado admisible', () => {
  it('filtra por customerId: un pedido de OTRO cliente nunca es elegible', () => {
    const ajeno = order({ id: 'ord_ajeno', customerId: '595981999999' });
    expect(pedidosElegiblesParaComprobante([ajeno], '595981000000')).toEqual([]);
  });
  it('excluye PAID y terminales', () => {
    const orders = [
      order({ id: 'o1', status: 'PENDING_PAYMENT' }),
      order({ id: 'o2', status: 'PENDING_VERIFICATION' }),
      order({ id: 'o3', status: 'PAID' }),
      order({ id: 'o4', status: 'CANCELLED' }),
      order({ id: 'o5', status: 'DELIVERED' }),
    ];
    expect(pedidosElegiblesParaComprobante(orders, '595981000000').map((o) => o.id)).toEqual(['o1', 'o2']);
  });
});

describe('índice y auditoría', () => {
  it('indexAttachments arma el mapa por attachmentId', () => {
    const a = att({ attachmentId: 'att_' + '1'.repeat(24) });
    const map = indexAttachments([a]);
    expect(map.get('att_' + '1'.repeat(24))).toBe(a);
    expect(map.get('att_desconocido')).toBeUndefined();
  });
  it('autorClasificacion distingue regla de persona', () => {
    expect(autorClasificacion(att())).toMatch(/regla autom/i);
    const humano = att({ classification: { value: 'payment_receipt_linked', source: 'human', confidence: 1, by: 'uid_9', at: ts(3) } });
    expect(autorClasificacion(humano)).toContain('uid_9');
  });
  it('classificationLabel nunca deja un estado sin nombre', () => {
    expect(classificationLabel('payment_receipt_candidate')).toBe('Posible comprobante');
    expect(classificationLabel('payment_receipt_linked')).toBe('Comprobante vinculado');
    expect(classificationLabel(undefined)).toBe('Sin clasificar');
  });
});
