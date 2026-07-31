/**
 * functions/attachments/mediaRetentionMaintenance.ts — Purga diaria de bytes (ADR-0016 §D)
 * =========================================================================================
 * Barrido por tenant en DOS pasos: (1) borra los BYTES de los adjuntos cuya retención venció;
 * (2) sella `retentionUntil` en los que todavía no lo tienen. El orden importa: lo sellado hoy
 * no puede purgarse hoy, así que entre "el tenant encendió la retención" y el primer borrado
 * pasa al menos una cadencia completa —y la fecha ya se ve en el panel—.
 *
 * Lo que hace que este job sea seguro no está acá sino en `attachments/retention.ts`: el
 * interruptor viene APAGADO por defecto, así que en un tenant sin config explícita esta corrida
 * lee un documento de config y no escribe absolutamente nada (ni siquiera una fecha).
 *
 * Nunca borra ni sella: comprobantes vinculados, candidatos a comprobante, adjuntos atados a un
 * pedido, y cualquier path que no sea EXACTAMENTE de la familia de adjuntos — los comprobantes
 * legacy quedan fuera por construcción. Y sin `retentionUntil` no se borra nada, nunca: no hace
 * falta ningún backfill destructivo para que esto sea seguro.
 *
 * Horario 02:40 (Asunción): no se pisa con los schedulers existentes (03:30 cobertura, 04:00,
 * 04:30/16:30 verificación de catálogo, 09:00).
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../audit/audit.js';
import {
  ATTACHMENT_PURGE_BATCH_LIMIT,
  runAttachmentRetentionPurge,
} from '../../attachments/retentionPurge.js';

export interface AttachmentRetentionSummary {
  /** Tenants vivos evaluados (se lee la config de todos; solo trabajan los que la encendieron). */
  tenants: number;
  /** Tenants con la purga ENCENDIDA. El resto no gastó ni una consulta a `attachments`. */
  habilitados: number;
  purgados: number;
  /** Adjuntos que recibieron su `retentionUntil` (sellado; no borra nada por sí solo). */
  sellados: number;
  fallidos: number;
  errores: number;
}

export async function runAttachmentRetentionMaintenance(
  nowMs = Date.now(),
): Promise<AttachmentRetentionSummary> {
  // Mismo criterio que el resto de los mantenimientos: solo empresas vivas.
  const tenants = await db().collection('tenants').select('status', 'deletedAt').get();
  const resumen: AttachmentRetentionSummary = {
    tenants: 0,
    habilitados: 0,
    purgados: 0,
    sellados: 0,
    fallidos: 0,
    errores: 0,
  };

  for (const t of tenants.docs) {
    const d = t.data() as { status?: string; deletedAt?: unknown };
    if (d.status !== 'ACTIVE' || d.deletedAt) continue;
    resumen.tenants += 1;
    try {
      const r = await runAttachmentRetentionPurge({
        tenantId: t.id,
        nowMs,
        limit: ATTACHMENT_PURGE_BATCH_LIMIT,
      });
      if (!r.enabled) continue; // purga apagada: no se tocó nada y no hay nada que auditar
      resumen.habilitados += 1;
      resumen.purgados += r.purged;
      resumen.sellados += r.stamped;
      resumen.fallidos += r.failed;
      // Borrar archivos de clientes es irreversible: queda auditado aunque el saldo sea cero,
      // para que se pueda demostrar QUÉ hizo la política cada día.
      await recordAudit({
        tenantId: t.id,
        action: 'attachment.retention_purged',
        targetType: 'attachments',
        targetId: 'retention',
        summary: `Purga de retención: ${r.purged} archivo(s) borrado(s) de ${r.scanned} evaluado(s); ${r.stamped} con plazo sellado`,
        metadata: {
          scanned: r.scanned,
          purged: r.purged,
          stamped: r.stamped,
          failed: r.failed,
          skipped: r.skipped,
        },
      });
      logger.info('Adjuntos: purga de retención ejecutada', {
        tenantId: t.id,
        scanned: r.scanned,
        purged: r.purged,
        stamped: r.stamped,
        failed: r.failed,
      });
    } catch (e) {
      // Un tenant que falla JAMÁS frena a los demás.
      resumen.errores += 1;
      logger.error('Adjuntos: la purga de retención falló para un tenant', e, { tenantId: t.id });
    }
  }
  return resumen;
}

export const attachmentRetentionMaintenance = onSchedule(
  { schedule: '40 2 * * *', timeZone: 'America/Asuncion', region: 'us-central1', timeoutSeconds: 540 },
  async () => {
    const r = await runAttachmentRetentionMaintenance();
    logger.info('Adjuntos: mantenimiento de retención terminado', { ...r });
  },
);
