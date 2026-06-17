/**
 * devMetaConnect / devMetaDisconnect — Conexión Meta en modo demo (Track D / D1)
 * =============================================================================
 *   POST { tenantId?, byUid? }  → conecta (demo) / desconecta.
 * En producción esto lo reemplaza el flujo OAuth real de Meta (callable + Secret
 * Manager). Acá es para construir y ver el Centro de Integración sin Meta.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { connectMetaDemo, disconnectMeta } from '../../meta/connect.js';
import { logger } from '../../lib/logger.js';

export const devMetaConnect = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string; byUid?: string };
  const tenantId = body.tenantId ?? 'perfumeria';
  try {
    await connectMetaDemo(tenantId, body.byUid ?? null);
    res.json({ ok: true });
  } catch (e) {
    logger.error('Error en devMetaConnect', e, { tenantId });
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

export const devMetaDisconnect = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string };
  const tenantId = body.tenantId ?? 'perfumeria';
  try {
    await disconnectMeta(tenantId);
    res.json({ ok: true });
  } catch (e) {
    logger.error('Error en devMetaDisconnect', e, { tenantId });
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
