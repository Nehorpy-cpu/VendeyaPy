/**
 * onOrderWriteStats — Trigger: recalcula los agregados al cambiar un pedido (P7)
 * =============================================================================
 * Cualquier alta/cambio en tenants/{t}/orders/{id} dispara el recálculo de
 * stats/public + stats/private + statsDaily de ese tenant. Así el dashboard solo
 * lee documentos ya listos (no recorre los pedidos en cada carga). Ver ADR-0006.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { recomputeTenantStats } from '../../stats/computeStats.js';
import { logger } from '../../lib/logger.js';

export const onOrderWriteStats = onDocumentWritten(
  { region: 'us-central1', document: 'tenants/{tenantId}/orders/{orderId}' },
  async (event) => {
    const tenantId = event.params.tenantId;
    try {
      await recomputeTenantStats(tenantId);
    } catch (e) {
      logger.error('Error recalculando stats (trigger onOrderWrite)', e, { tenantId });
    }
  },
);
