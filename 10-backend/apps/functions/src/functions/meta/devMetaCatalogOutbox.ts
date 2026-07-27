/**
 * META-CATALOG-OUTBOX-1 — Endpoint DEV para correr el mantenimiento del outbox bajo demanda
 * (verify-meta-catalog.mjs). Mismo core que el scheduler. 404 en producción (guardDevEndpoint),
 * como el resto de los dev*.
 *
 * Acepta `?tenantId=` para drenar UN tenant (los E2E lo necesitan para probar el aislamiento:
 * drenar arfagi no puede tocar nada de credipower).
 */
import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { localPublicView } from '../../meta/catalog.js';
import { runCatalogOutboxForTenant } from '../../meta/catalogOutboxWorker.js';
import { runMetaCatalogOutboxMaintenance } from '../scheduled/metaCatalogOutbox.js';

export const devRunMetaCatalogOutbox = onRequest({ region: 'us-central1' }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  try {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
    // `graceMs` permite al E2E confirmar sin esperar la ventana de gracia real (60 s), que
    // existe porque `items_batch` es asíncrono. La ventana en sí se prueba aparte.
    const graciaMs = typeof req.query.graceMs === 'string' ? Number(req.query.graceMs) : undefined;
    if (tenantId) {
      // MISMO fail-closed que el scheduler: un tenant suspendido o dado de baja no se drena ni
      // siquiera desde el endpoint de desarrollo.
      const t = await db().doc(`tenants/${tenantId}`).get();
      const d = t.data() as { status?: string; deletedAt?: unknown } | undefined;
      if (!t.exists || d?.status !== 'ACTIVE' || d?.deletedAt) {
        res.status(200).json({ ok: true, skipped: 'tenant_not_active' });
        return;
      }
      const r = await runCatalogOutboxForTenant(tenantId, localPublicView, {
        ...(Number.isFinite(graciaMs) && (graciaMs as number) >= 0 ? { graciaMs: graciaMs as number } : {}),
      });
      res.status(200).json({ ok: true, result: r });
      return;
    }
    await runMetaCatalogOutboxMaintenance();
    res.status(200).json({ ok: true });
  } catch (e) {
    logger.error('devRunMetaCatalogOutbox falló', e);
    res.status(500).json({ ok: false });
  }
});
