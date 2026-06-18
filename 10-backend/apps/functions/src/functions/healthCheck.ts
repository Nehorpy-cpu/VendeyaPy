/**
 * healthCheck — Estado del servicio (Fase 5)
 * GET /healthCheck → { status, version, env, checks: { firestore } }
 * Útil para uptime monitors / load balancers. No expone datos sensibles.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { db } from '../lib/firebase.js';

export const healthCheck = onRequest({ region: 'us-central1', cors: true }, async (_req, res) => {
  const checks: Record<string, 'ok' | 'error'> = {};
  let ok = true;
  try {
    // Ping de conectividad a Firestore (get sobre un doc inexistente igual valida la conexión).
    await db().collection('_health').doc('ping').get();
    checks.firestore = 'ok';
  } catch {
    checks.firestore = 'error';
    ok = false;
  }
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    service: 'aiafg-functions',
    version: process.env['npm_package_version'] ?? '0.1.0',
    env: process.env.NODE_ENV ?? (process.env.FUNCTIONS_EMULATOR === 'true' ? 'emulator' : 'unknown'),
    emulator: process.env.FUNCTIONS_EMULATOR === 'true',
    checks,
    timestamp: new Date().toISOString(),
  });
});
