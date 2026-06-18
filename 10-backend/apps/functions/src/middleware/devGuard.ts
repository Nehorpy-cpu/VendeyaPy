/**
 * devGuard — Blindaje de endpoints dev* y simuladores (Fase 2).
 * ===========================================================
 * Política "proteger + excluir de prod":
 *   - En el emulador (FUNCTIONS_EMULATOR=true): SIEMPRE permitido. Así la demo local,
 *     los seeds y los verify-*.mjs siguen funcionando sin fricción.
 *   - Fuera del emulador: permitido SÓLO si ENABLE_DEV_ENDPOINTS=true Y el header
 *     `x-internal-secret` coincide con DEV_ENDPOINTS_SECRET (para staging/demo online).
 *   - En producción (sin esas dos condiciones): DENEGADO (404). Ni los simuladores
 *     (devMessage, devConfirmPayment, ...) ni los jobs internos (devRecompute*, devSync*,
 *     devGenerate*, ...) quedan expuestos públicamente.
 *
 * Los endpoints REALES (metaWebhook con verificación de firma, callables autenticados)
 * NO usan esto: tienen su propio control.
 */
import { timingSafeEqual } from 'node:crypto';

// Tipos estructurales mínimos: evitan acoplar a express/firebase y aceptan el req/res reales.
type HeaderReader = { get(name: string): string | string[] | undefined };
type JsonResponder = { status(code: number): { json(body: unknown): unknown } };

function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** ¿La petición puede usar un endpoint dev*? Ver política arriba. */
export function devEndpointAllowed(req: HeaderReader): boolean {
  if (isEmulator()) return true;
  const enabled = process.env.ENABLE_DEV_ENDPOINTS === 'true';
  const secret = process.env.DEV_ENDPOINTS_SECRET;
  if (!enabled || !secret) return false;
  const raw = req.get('x-internal-secret');
  const provided = typeof raw === 'string' ? raw : '';
  return provided.length > 0 && safeEqual(provided, secret);
}

/**
 * Guarda para usar al inicio de un handler dev*:
 *   if (!guardDevEndpoint(req, res)) return;
 * Si no está permitido responde 404 (no revela la existencia del endpoint).
 */
export function guardDevEndpoint(req: HeaderReader, res: JsonResponder): boolean {
  if (devEndpointAllowed(req)) return true;
  res.status(404).json({ ok: false, error: 'not found' });
  return false;
}
