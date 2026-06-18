/**
 * payments/stripeSignature.ts — Verificación de firma de webhooks de Stripe (Fase 3)
 * ==================================================================================
 * Implementa el esquema oficial de Stripe SIN el SDK (node:crypto): la cabecera
 * `Stripe-Signature: t=<ts>,v1=<hmac>` donde hmac = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * Comparación en tiempo constante + tolerancia de timestamp (anti-replay).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export class StripeSignatureError extends Error {
  constructor(msg = 'Firma de Stripe inválida') {
    super(msg);
    this.name = 'StripeSignatureError';
  }
}

function parseHeader(header: string): { t: number; v1: string[] } {
  const v1: string[] = [];
  let t = 0;
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't' && v) t = parseInt(v, 10);
    else if (k === 'v1' && v) v1.push(v);
  }
  return { t, v1 };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Verifica la firma de Stripe. Lanza StripeSignatureError si no valida.
 * `nowSec` se inyecta en tests para determinismo; por defecto usa la hora actual.
 */
export function verifyStripeSignature(
  payload: string | Buffer,
  sigHeader: string | undefined,
  secret: string,
  opts?: { toleranceSec?: number; nowSec?: number },
): void {
  if (!sigHeader) throw new StripeSignatureError('Falta la cabecera Stripe-Signature');
  const { t, v1 } = parseHeader(sigHeader);
  if (!t || v1.length === 0) throw new StripeSignatureError('Cabecera mal formada');

  const body = typeof payload === 'string' ? payload : payload.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  if (!v1.some((sig) => safeEqualHex(expected, sig))) throw new StripeSignatureError();

  const tolerance = opts?.toleranceSec ?? 300;
  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) {
    throw new StripeSignatureError('Timestamp fuera de tolerancia (posible replay)');
  }
}
