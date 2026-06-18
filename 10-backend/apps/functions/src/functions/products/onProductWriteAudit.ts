/**
 * onProductWriteAudit — Trigger: audita altas/cambios/bajas de producto (Fase 5)
 * ==============================================================================
 * Captura TODO cambio en el catálogo (lo escriba el panel por reglas o un job).
 * El trigger no conoce al actor humano → queda como cambio del sistema; las acciones
 * con actor (roles, pagos, handoff, Meta) se auditan en sus callables.
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { recordAudit, type AuditAction } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';

export const onProductWriteAudit = onDocumentWritten(
  { region: 'us-central1', document: 'tenants/{tenantId}/products/{productId}' },
  async (event) => {
    try {
      const { tenantId, productId } = event.params as { tenantId: string; productId: string };
      const beforeExists = event.data?.before?.exists ?? false;
      const afterExists = event.data?.after?.exists ?? false;
      const action: AuditAction = !beforeExists ? 'product.created' : !afterExists ? 'product.deleted' : 'product.updated';
      const name =
        (event.data?.after?.data()?.name as string | undefined) ??
        (event.data?.before?.data()?.name as string | undefined) ??
        productId;
      const verbo = action === 'product.created' ? 'creado' : action === 'product.deleted' ? 'eliminado' : 'actualizado';
      await recordAudit({ tenantId, action, targetType: 'product', targetId: productId, summary: `Producto ${verbo}: ${name}` });
    } catch (e) {
      logger.error('Error en onProductWriteAudit', e);
    }
  },
);
