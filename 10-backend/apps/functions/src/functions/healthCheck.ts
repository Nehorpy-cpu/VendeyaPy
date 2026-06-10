/**
 * Endpoint de health check.
 * GET /healthCheck → { status: "ok", timestamp, version }
 */

import { onRequest } from 'firebase-functions/v2/https';

export const healthCheck = onRequest(
  { region: 'us-central1', cors: true },
  (req, res) => {
    res.json({
      status: 'ok',
      service: 'ventaporwhatsapp-functions',
      timestamp: new Date().toISOString(),
      version: process.env['npm_package_version'] ?? '0.1.0',
    });
  },
);
