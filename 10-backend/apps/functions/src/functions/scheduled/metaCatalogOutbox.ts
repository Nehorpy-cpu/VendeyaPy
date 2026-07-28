/**
 * META-CATALOG-OUTBOX-1 — Mantenimiento del outbox de catálogo (cada 5 minutos).
 * ==============================================================================
 * Tres fases por tenant, en este orden y por una razón:
 *   1. SWEEP      normaliza lo que ningún worker vivo va a tocar (leases vencidos), así el
 *                 drenaje siguiente ve la cola real y no fantasmas.
 *   2. DRENAJE    reclama, revalida y envía UN lote.
 *   3. CONFIRMACIÓN releé el catálogo y declara `succeeded` solo con evidencia.
 *
 * Cadencia: cada 5 minutos. El consumo por corrida y por tenant está acotado por diseño —un
 * submit por drenaje, la relectura del catálogo (una llamada por página) y hasta
 * `MAX_BATCH_STATUS_PER_RUN` consultas de estado, cada una con sus reintentos internos de
 * GET—; el peor caso real lo reporta `reconcile.metaCalls`. No se asume ningún límite
 * publicado por Meta. Un tenant sin cola no gasta ninguna llamada: el gate de config y la
 * query de `queued` cortan antes de tocar la red.
 *
 * Fail-closed por tenant: sin config, con `mode` distinto de `live` o sin el plan que habilita
 * marketing, la corrida no escribe nada. Un error en un tenant JAMÁS frena a los demás.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { localPublicView } from '../../meta/catalog.js';
import { runCatalogOutboxForTenant } from '../../meta/catalogOutboxWorker.js';

export async function runMetaCatalogOutboxMaintenance(): Promise<void> {
  // SOLO tenants vivos: una empresa suspendida o dada de baja no puede seguir escribiendo en
  // su catálogo de Meta por una cola vieja.
  const tenants = await db().collection('tenants').select('status', 'deletedAt').get();
  for (const t of tenants.docs) {
    const d = t.data() as { status?: string; deletedAt?: unknown };
    if (d.status !== 'ACTIVE' || d.deletedAt) continue;
    try {
      const r = await runCatalogOutboxForTenant(t.id, localPublicView);
      if (r.drain.claimed || r.reconcile.checked || r.sweep.normalized || r.sweep.aged) {
        logger.info('Outbox de catálogo: mantenimiento', {
          tenantId: t.id,
          reclamados: r.drain.claimed,
          enviados: r.drain.submitted,
          confirmados: r.reconcile.succeeded,
          fallidos: r.reconcile.failed,
          normalizados: r.sweep.normalized,
        });
      }
    } catch (e) {
      logger.error('Outbox de catálogo: el mantenimiento falló para un tenant', e, { tenantId: t.id });
    }
  }
}

export const metaCatalogOutboxMaintenance = onSchedule(
  // timeout explícito por debajo de la cadencia: una corrida colgada no puede solaparse con
  // la siguiente indefinidamente (el claim/lease ya protege, pero el techo corta el gasto).
  { schedule: '*/5 * * * *', timeZone: 'America/Asuncion', region: 'us-central1', timeoutSeconds: 240 },
  async () => {
    await runMetaCatalogOutboxMaintenance();
  },
);
