/**
 * ai/productVisionFlag.ts — El flag de visión como módulo HOJA (review BAJO 3)
 * ============================================================================
 * Vive solo: el productor (onAiVisionProducer) necesita únicamente esta lectura y no debe
 * arrastrar al cold start el runtime completo del worker (cliente de WhatsApp, catálogo,
 * gateway de IA). Fail-closed: solo el literal `true` enciende; ante cualquier duda, apagado.
 */
import { db, paths } from '../lib/firebase.js';

export async function productVisionActiva(tenantId: string): Promise<boolean> {
  try {
    const doc = (await db().doc(`${paths.tenant(tenantId)}/config/productVision`).get()).data() as { enabled?: unknown } | undefined;
    return doc?.enabled === true;
  } catch {
    return false; // ante cualquier duda, apagado
  }
}
