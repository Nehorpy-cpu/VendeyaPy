/**
 * devSyncCatalogToMeta — Dry-run de la sync de catálogo (dev/emulador)
 * ====================================================================
 *   POST { tenantId }  → SOLO ese tenant y SOLO dry-run (cero escrituras en Meta).
 *   El panel ya NO usa este endpoint (va por runTenantJob autenticado); queda como
 *   utilidad de emulador detrás de guardDevEndpoint. META-CATALOG-LIVE-1.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import { runCatalogSync } from '../../meta/catalog.js';
import { logger } from '../../lib/logger.js';

export const devSyncCatalogToMeta = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const body = (req.body ?? {}) as { tenantId?: string };
  // tenantId OBLIGATORIO: sin modo "todos" — un barrido cross-tenant tocaría el token
  // de Meta de cada empresa y devolvería sus catálogos completos en una sola respuesta.
  if (!body.tenantId) { res.status(400).json({ ok: false, error: 'Falta tenantId (una empresa por request).' }); return; }
  try {
    const run = await runCatalogSync(body.tenantId, { mode: 'dry_run' });
    res.json({ ok: true, runs: { [body.tenantId]: run } });
  } catch (e) {
    logger.error('Error en devSyncCatalogToMeta', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
