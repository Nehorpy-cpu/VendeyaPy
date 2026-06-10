/**
 * Verificación de firmas de webhooks externos.
 * Ver ARCHITECTURE.md §5.4.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from '../lib/errors.js';

/**
 * Verifica firma X-Hub-Signature-256 de WhatsApp / Meta.
 * Formato: "sha256=<hex>"
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signature: string | undefined,
  appSecret: string,
): void {
  if (!signature || !signature.startsWith('sha256=')) {
    throw new WebhookSignatureError();
  }
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signature.slice('sha256='.length);
  if (!safeEqualHex(expected, received)) {
    throw new WebhookSignatureError();
  }
}

/**
 * Verifica firma de Bancard (hash con private key del tenant).
 * El formato exacto depende de la respuesta de Bancard — se implementa en el handler.
 */
export function verifyBancardSignature(
  payload: Record<string, unknown>,
  privateKey: string,
): void {
  // Implementación específica en src/integrations/bancard/
  if (!payload || !privateKey) {
    throw new WebhookSignatureError();
  }
  // TODO: implementar según spec Bancard
}

/**
 * Verifica firma del secreto interno usado entre n8n y Cloud Functions.
 */
export function verifyInternalSecret(
  receivedSecret: string | undefined,
  expectedSecret: string,
): void {
  if (!receivedSecret) throw new WebhookSignatureError();
  if (!safeEqualHex(receivedSecret, expectedSecret)) {
    throw new WebhookSignatureError();
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
