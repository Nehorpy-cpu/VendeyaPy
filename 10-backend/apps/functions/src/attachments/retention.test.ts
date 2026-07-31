/**
 * retention.test.ts — Política y ejecución de la purga de adjuntos (área C, ADR-0016 §D).
 * Cubre: flag APAGADO por defecto (no borra ni consulta), exclusiones (evidencia de pago, atado a
 * pedido, comprobante legacy, sin fecha explícita), idempotencia y rollback del claim.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_RETENTION_DEFAULT_DAYS,
  ATTACHMENT_RETENTION_DISABLED,
  ATTACHMENT_RETENTION_MAX_DAYS,
  ATTACHMENT_RETENTION_MIN_DAYS,
  computeAttachmentRetentionUntilMs,
  decideAttachmentPurge,
  decideRetentionStamp,
  parseAttachmentRetentionConfig,
  type AttachmentPurgeCandidate,
  type AttachmentRetentionConfig,
} from './retention.js';
import {
  runAttachmentRetentionPurge,
  toPurgeCandidate,
  type AttachmentPurgeDeps,
} from './retentionPurge.js';

const T = 'arfagi';
const ATT = 'att_ab0123456789abcdef012345';
const ATT_PATH = `tenants/${T}/attachments/ab/${ATT}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const AHORA = 1_800_000_000_000;

const ON: AttachmentRetentionConfig = { purgeEnabled: true, retentionDays: 90 };

const candidato = (over: Partial<AttachmentPurgeCandidate> = {}): AttachmentPurgeCandidate => ({
  attachmentId: ATT,
  tenantId: T,
  declaredTenantId: T,
  storagePath: ATT_PATH,
  ingestState: 'stored',
  classification: 'generic_media',
  orderCandidateId: null,
  createdAtMs: AHORA - 400 * DAY_MS,
  retentionUntilMs: AHORA - 1,
  purgedAtMs: null,
  ...over,
});

describe('parseAttachmentRetentionConfig — fail-closed', () => {
  it('sin config, config corrupta o valores truchos ⇒ purga APAGADA', () => {
    for (const raw of [undefined, null, 0, 'x', [], { retention: true }, { purgeEnabled: 'true' }, { purgeEnabled: 1 }]) {
      expect(parseAttachmentRetentionConfig(raw).purgeEnabled, JSON.stringify(raw)).toBe(false);
    }
    expect(parseAttachmentRetentionConfig(undefined)).toEqual(ATTACHMENT_RETENTION_DISABLED);
  });

  it('solo el booleano `true` EXACTO enciende la purga', () => {
    expect(parseAttachmentRetentionConfig({ purgeEnabled: true }).purgeEnabled).toBe(true);
  });

  it('la ventana se acota entre el piso y el techo; lo inválido cae al default', () => {
    expect(parseAttachmentRetentionConfig({ retentionDays: 120 }).retentionDays).toBe(120);
    for (const days of [0, 1, ATTACHMENT_RETENTION_MIN_DAYS - 1, ATTACHMENT_RETENTION_MAX_DAYS + 1, -30, 4.5, NaN, '90']) {
      expect(parseAttachmentRetentionConfig({ retentionDays: days }).retentionDays, String(days)).toBe(
        ATTACHMENT_RETENTION_DEFAULT_DAYS,
      );
    }
    expect(parseAttachmentRetentionConfig({ retentionDays: ATTACHMENT_RETENTION_MIN_DAYS }).retentionDays).toBe(
      ATTACHMENT_RETENTION_MIN_DAYS,
    );
  });
});

describe('computeAttachmentRetentionUntilMs', () => {
  it('se calcula aunque la purga esté apagada (metadata ≠ política)', () => {
    expect(computeAttachmentRetentionUntilMs(ATTACHMENT_RETENTION_DISABLED, AHORA)).toBe(
      AHORA + ATTACHMENT_RETENTION_DEFAULT_DAYS * DAY_MS,
    );
    expect(computeAttachmentRetentionUntilMs(ON, AHORA)).toBe(AHORA + 90 * DAY_MS);
  });

  it('un `createdAt` inválido no produce una fecha inventada', () => {
    for (const ms of [0, -1, NaN, Infinity]) {
      expect(computeAttachmentRetentionUntilMs(ON, ms)).toBeNull();
    }
  });
});

describe('decideAttachmentPurge — exclusiones', () => {
  it('con la purga apagada nunca se purga, ni siquiera lo vencido', () => {
    expect(decideAttachmentPurge(ATTACHMENT_RETENTION_DISABLED, candidato(), AHORA)).toEqual({
      purge: false,
      reason: 'purge_disabled',
    });
  });

  it('encendida y vencido → se purga', () => {
    expect(decideAttachmentPurge(ON, candidato(), AHORA)).toEqual({ purge: true });
  });

  it('evidencia de pago (candidato o vinculado) NUNCA se borra', () => {
    for (const classification of ['payment_receipt_candidate', 'payment_receipt_linked'] as const) {
      expect(decideAttachmentPurge(ON, candidato({ classification }), AHORA)).toEqual({
        purge: false,
        reason: 'payment_evidence',
      });
    }
  });

  it('atado a un pedido NUNCA se borra, aunque la clasificación diga otra cosa', () => {
    expect(decideAttachmentPurge(ON, candidato({ orderCandidateId: 'ord_1' }), AHORA)).toEqual({
      purge: false,
      reason: 'linked_to_order',
    });
  });

  it('los comprobantes legacy quedan fuera del alcance por la forma del path', () => {
    const legacy = `tenants/${T}/orders/ord_1/comprobantes/wamid.X.jpg`;
    expect(decideAttachmentPurge(ON, candidato({ storagePath: legacy }), AHORA)).toEqual({
      purge: false,
      reason: 'path_not_purgeable',
    });
  });

  it('paths de otro tenant, con traversal o mal formados no se borran', () => {
    for (const storagePath of [
      `tenants/credipower/attachments/ab/${ATT}`,
      `tenants/${T}/attachments/ab/../../secreto`,
      `tenants/${T}/attachments/zz/${ATT}`,
      `tenants/${T}/products/p1/foto.jpg`,
    ]) {
      expect(decideAttachmentPurge(ON, candidato({ storagePath }), AHORA), storagePath).toEqual({
        purge: false,
        reason: 'path_not_purgeable',
      });
    }
  });

  it('un doc que se auto-declara de OTRA empresa no se purga (hallazgo, no salteo cualquiera)', () => {
    // Vector exacto: el doc vive en tenants/arfagi/… pero dice ser de credipower y su path apunta
    // al bucket de credipower. Si el tenant lo eligiera el documento, la whitelist lo aprobaría.
    expect(
      decideAttachmentPurge(
        ON,
        candidato({
          declaredTenantId: 'credipower',
          storagePath: `tenants/credipower/attachments/ab/${ATT}`,
        }),
        AHORA,
      ),
    ).toEqual({ purge: false, reason: 'tenant_mismatch' });
    // También cuando el path SÍ es del tenant de la ruta: la discrepancia sola ya alcanza.
    expect(decideAttachmentPurge(ON, candidato({ declaredTenantId: 'credipower' }), AHORA)).toEqual({
      purge: false,
      reason: 'tenant_mismatch',
    });
    // Un doc que no declara tenant no es un hallazgo: la ruta manda y el resto se evalúa normal.
    expect(decideAttachmentPurge(ON, candidato({ declaredTenantId: null }), AHORA)).toEqual({ purge: true });
  });

  it('sin `retentionUntil` explícito no se borra: es lo que hace innecesario el backfill', () => {
    expect(decideAttachmentPurge(ON, candidato({ retentionUntilMs: null }), AHORA)).toEqual({
      purge: false,
      reason: 'no_retention_deadline',
    });
  });

  it('todavía no vencido → se conserva', () => {
    expect(decideAttachmentPurge(ON, candidato({ retentionUntilMs: AHORA + 1 }), AHORA)).toEqual({
      purge: false,
      reason: 'retention_not_reached',
    });
    // Borde: vencimiento EXACTAMENTE ahora ⇒ ya es elegible.
    expect(decideAttachmentPurge(ON, candidato({ retentionUntilMs: AHORA }), AHORA)).toEqual({ purge: true });
  });

  it('sin bytes almacenados no hay nada que borrar', () => {
    expect(decideAttachmentPurge(ON, candidato({ storagePath: null }), AHORA)).toEqual({
      purge: false,
      reason: 'no_stored_bytes',
    });
    expect(decideAttachmentPurge(ON, candidato({ ingestState: 'rejected' }), AHORA)).toEqual({
      purge: false,
      reason: 'no_stored_bytes',
    });
  });

  it('ya purgado → idempotente', () => {
    expect(decideAttachmentPurge(ON, candidato({ purgedAtMs: AHORA - 10 }), AHORA)).toEqual({
      purge: false,
      reason: 'already_purged',
    });
  });
});

describe('decideRetentionStamp — sellado de la fecha de retención', () => {
  const sinFecha = (over: Partial<AttachmentPurgeCandidate> = {}) =>
    candidato({ retentionUntilMs: null, ...over });

  it('con la purga apagada NO se sella nada (cero escrituras)', () => {
    expect(decideRetentionStamp(ATTACHMENT_RETENTION_DISABLED, sinFecha(), AHORA)).toEqual({
      stamp: false,
      reason: 'purge_disabled',
    });
  });

  it('sella createdAt + ventana para un adjunto reciente', () => {
    const creado = AHORA - 10 * DAY_MS;
    expect(decideRetentionStamp(ON, sinFecha({ createdAtMs: creado }), AHORA)).toEqual({
      stamp: true,
      retentionUntilMs: creado + 90 * DAY_MS,
    });
  });

  it('nunca sella una fecha ya vencida: un adjunto viejo recibe `ahora` (un día de gracia)', () => {
    const r = decideRetentionStamp(ON, sinFecha({ createdAtMs: AHORA - 400 * DAY_MS }), AHORA);
    expect(r).toEqual({ stamp: true, retentionUntilMs: AHORA });
    // Con esa fecha, la purga de ESTA corrida no lo alcanza (se sella al final del barrido).
    expect(decideAttachmentPurge(ON, candidato({ retentionUntilMs: AHORA }), AHORA - 1)).toEqual({
      purge: false,
      reason: 'retention_not_reached',
    });
  });

  it('idempotente: lo que ya tiene fecha no se vuelve a sellar', () => {
    expect(decideRetentionStamp(ON, candidato(), AHORA)).toEqual({ stamp: false, reason: 'already_stamped' });
  });

  it('la evidencia de pago y lo atado a un pedido NO reciben fecha (segundo candado)', () => {
    expect(decideRetentionStamp(ON, sinFecha({ classification: 'payment_receipt_linked' }), AHORA)).toEqual({
      stamp: false,
      reason: 'payment_evidence',
    });
    expect(decideRetentionStamp(ON, sinFecha({ classification: 'payment_receipt_candidate' }), AHORA)).toEqual({
      stamp: false,
      reason: 'payment_evidence',
    });
    expect(decideRetentionStamp(ON, sinFecha({ orderCandidateId: 'ord_9' }), AHORA)).toEqual({
      stamp: false,
      reason: 'linked_to_order',
    });
  });

  it('un doc con tenant declarado distinto al de su ruta tampoco recibe fecha', () => {
    expect(decideRetentionStamp(ON, sinFecha({ declaredTenantId: 'credipower' }), AHORA)).toEqual({
      stamp: false,
      reason: 'tenant_mismatch',
    });
  });

  it('un path ajeno a la familia de adjuntos tampoco recibe fecha', () => {
    expect(
      decideRetentionStamp(ON, sinFecha({ storagePath: `tenants/${T}/orders/ord_1/comprobantes/x.jpg` }), AHORA),
    ).toEqual({ stamp: false, reason: 'path_not_purgeable' });
  });

  it('sin `createdAt` confiable no se inventa una fecha', () => {
    expect(decideRetentionStamp(ON, sinFecha({ createdAtMs: null }), AHORA)).toEqual({
      stamp: false,
      reason: 'no_retention_deadline',
    });
  });
});

// ---------------------------------------------------------------------------

interface Registro {
  listados: number;
  claims: string[];
  borrados: string[];
  liberados: string[];
  sellados: Array<{ id: string; hasta: number }>;
}

const nuevoRegistro = (): Registro => ({
  listados: 0,
  claims: [],
  borrados: [],
  liberados: [],
  sellados: [],
});

const purgeDeps = (
  candidatos: AttachmentPurgeCandidate[],
  config: AttachmentRetentionConfig,
  registro: Registro,
  over: Partial<AttachmentPurgeDeps> = {},
): AttachmentPurgeDeps => ({
  loadRetentionConfig: async () => config,
  listCandidates: async () => {
    registro.listados += 1;
    return candidatos;
  },
  listUnstamped: async () => {
    registro.listados += 1;
    return candidatos.filter((c) => c.retentionUntilMs === null);
  },
  stampRetention: async (_t, id, hasta) => {
    registro.sellados.push({ id, hasta });
  },
  claimForPurge: async (_t, attachmentId) => {
    registro.claims.push(attachmentId);
    const fresco = candidatos.find((c) => c.attachmentId === attachmentId);
    const decision = decideAttachmentPurge(config, fresco as AttachmentPurgeCandidate, AHORA);
    return decision.purge
      ? { claimed: true, storagePath: (fresco as AttachmentPurgeCandidate).storagePath as string }
      : { claimed: false, reason: decision.reason };
  },
  deleteObject: async (p) => {
    registro.borrados.push(p);
  },
  releaseClaim: async (_t, attachmentId) => {
    registro.liberados.push(attachmentId);
  },
  ...over,
});

describe('runAttachmentRetentionPurge', () => {
  it('purga APAGADA: no lista, no reclama y no borra nada', async () => {
    const registro = nuevoRegistro();
    const r = await runAttachmentRetentionPurge(
      { tenantId: T, nowMs: AHORA },
      purgeDeps([candidato()], ATTACHMENT_RETENTION_DISABLED, registro),
    );
    expect(r).toMatchObject({ enabled: false, scanned: 0, purged: 0, stamped: 0, failed: 0 });
    expect(registro.listados).toBe(0);
    expect(registro.claims).toHaveLength(0);
    expect(registro.borrados).toHaveLength(0);
    // Ni siquiera se sella una fecha: con la purga apagada este job no escribe NADA.
    expect(registro.sellados).toHaveLength(0);
  });

  it('purga ENCENDIDA: borra lo vencido y respeta TODAS las exclusiones', async () => {
    const registro = nuevoRegistro();
    const otro = 'att_cd0123456789abcdef012345';
    const candidatos = [
      candidato(), // vencido y sin ataduras → se borra
      candidato({ attachmentId: 'att_11' + '0'.repeat(22), classification: 'payment_receipt_linked' }),
      candidato({ attachmentId: 'att_22' + '0'.repeat(22), orderCandidateId: 'ord_9' }),
      candidato({ attachmentId: 'att_33' + '0'.repeat(22), retentionUntilMs: null }),
      candidato({
        attachmentId: 'att_44' + '0'.repeat(22),
        storagePath: `tenants/${T}/orders/ord_1/comprobantes/x.jpg`,
      }),
      candidato({ attachmentId: otro, storagePath: `tenants/${T}/attachments/cd/${otro}` }), // se borra
    ];
    const r = await runAttachmentRetentionPurge({ tenantId: T, nowMs: AHORA }, purgeDeps(candidatos, ON, registro));
    expect(r.enabled).toBe(true);
    expect(r.scanned).toBe(6);
    expect(r.purged).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.skipped).toMatchObject({
      payment_evidence: 1,
      linked_to_order: 1,
      no_retention_deadline: 1,
      path_not_purgeable: 1,
      purge_disabled: 0,
    });
    expect(registro.borrados).toEqual([ATT_PATH, `tenants/${T}/attachments/cd/${otro}`]);
    // El único sin fecha recibe la suya al FINAL del barrido ⇒ no se borró en esta misma corrida.
    expect(r.stamped).toBe(1);
    expect(registro.sellados).toEqual([{ id: 'att_33' + '0'.repeat(22), hasta: AHORA }]);
  });

  it('si el claim pierde la carrera (el vendedor lo marcó comprobante), no se borra', async () => {
    const registro = nuevoRegistro();
    const r = await runAttachmentRetentionPurge(
      { tenantId: T, nowMs: AHORA },
      purgeDeps([candidato()], ON, registro, {
        claimForPurge: async () => ({ claimed: false, reason: 'payment_evidence' }),
      }),
    );
    expect(r.purged).toBe(0);
    expect(r.skipped.payment_evidence).toBe(1);
    expect(registro.borrados).toHaveLength(0);
  });

  it('si el borrado de bytes falla, el claim se REVIERTE para reintentar mañana', async () => {
    const registro = nuevoRegistro();
    const r = await runAttachmentRetentionPurge(
      { tenantId: T, nowMs: AHORA },
      purgeDeps([candidato()], ON, registro, {
        deleteObject: async () => {
          throw new Error('bucket gs://super-secreto no responde');
        },
      }),
    );
    expect(r).toMatchObject({ enabled: true, purged: 0, failed: 1 });
    expect(registro.liberados).toEqual([ATT]);
  });

  it('el lote está acotado: nunca se pide más que el tope por corrida', async () => {
    const pedidos: number[] = [];
    await runAttachmentRetentionPurge({ tenantId: T, nowMs: AHORA, limit: 10_000 }, {
      loadRetentionConfig: async () => ON,
      listCandidates: async (_t, _n, limit) => {
        pedidos.push(limit);
        return [];
      },
      listUnstamped: async (_t, limit) => {
        pedidos.push(limit);
        return [];
      },
      stampRetention: async () => undefined,
      claimForPurge: async () => ({ claimed: false, reason: 'already_purged' }),
      deleteObject: async () => undefined,
      releaseClaim: async () => undefined,
    });
    expect(pedidos).toEqual([200, 200]);
  });

  it('si el sellado falla, se cuenta como fallo y no se borra nada', async () => {
    const registro = nuevoRegistro();
    const r = await runAttachmentRetentionPurge(
      { tenantId: T, nowMs: AHORA },
      purgeDeps([candidato({ retentionUntilMs: null })], ON, registro, {
        stampRetention: async () => {
          throw new Error('firestore no responde');
        },
      }),
    );
    expect(r).toMatchObject({ enabled: true, purged: 0, stamped: 0, failed: 1 });
    expect(registro.borrados).toHaveLength(0);
  });
});

describe('toPurgeCandidate — proyección defensiva', () => {
  it('un documento vacío o adulterado nunca queda purgable', () => {
    const c = toPurgeCandidate(T, ATT, undefined);
    expect(c).toMatchObject({
      tenantId: T,
      storagePath: null,
      ingestState: 'received',
      classification: 'unclassified',
      orderCandidateId: null,
      createdAtMs: null,
      retentionUntilMs: null,
      purgedAtMs: null,
    });
    expect(decideAttachmentPurge(ON, c, AHORA)).toEqual({ purge: false, reason: 'no_stored_bytes' });
  });

  it('el tenant lo fija la RUTA: el campo del documento no tiene autoridad', () => {
    const c = toPurgeCandidate(T, ATT, {
      tenantId: 'credipower',
      ingestState: 'stored',
      classification: { value: 'generic_media' },
      storage: { path: ATT_PATH },
      retentionUntil: { toMillis: () => AHORA - 5 },
      purgedAt: null,
    });
    expect(c.tenantId).toBe(T);
    expect(c.declaredTenantId).toBe('credipower');
    expect(c.retentionUntilMs).toBe(AHORA - 5);
    expect(decideAttachmentPurge(ON, c, AHORA)).toEqual({ purge: false, reason: 'tenant_mismatch' });
  });

  it('un doc sin `tenantId` no es un hallazgo: se evalúa contra el tenant de la ruta', () => {
    const c = toPurgeCandidate(T, ATT, {
      ingestState: 'stored',
      classification: { value: 'generic_media' },
      storage: { path: ATT_PATH },
      retentionUntil: { toMillis: () => AHORA - 5 },
    });
    expect(c.tenantId).toBe(T);
    expect(c.declaredTenantId).toBeNull();
    expect(decideAttachmentPurge(ON, c, AHORA)).toEqual({ purge: true });
  });
});

describe('borrado cross-tenant: la primitiva no existe', () => {
  it('un doc sembrado en un tenant NO puede hacer borrar el archivo de otro', async () => {
    const registro = nuevoRegistro();
    // El documento vive bajo `tenants/arfagi/attachments/att_…` pero se declara de credipower y su
    // `storage.path` apunta al bucket de credipower. Antes: el candidato tomaba el tenant del
    // CAMPO, la whitelist validaba contra credipower, pasaba, y la corrida de arfagi borraba un
    // archivo de credipower.
    const envenenado = toPurgeCandidate(T, ATT, {
      tenantId: 'credipower',
      ingestState: 'stored',
      classification: { value: 'generic_media' },
      storage: { path: `tenants/credipower/attachments/ab/${ATT}` },
      createdAt: { toMillis: () => AHORA - 400 * DAY_MS },
      retentionUntil: { toMillis: () => AHORA - 1 },
    });
    const r = await runAttachmentRetentionPurge(
      { tenantId: T, nowMs: AHORA },
      purgeDeps([envenenado], ON, registro),
    );
    expect(r.purged).toBe(0);
    expect(r.skipped.tenant_mismatch).toBe(1);
    expect(registro.borrados).toHaveLength(0);
    expect(registro.claims).toHaveLength(0); // ni siquiera se abre la transacción de claim
    expect(registro.sellados).toHaveLength(0);
  });
});
