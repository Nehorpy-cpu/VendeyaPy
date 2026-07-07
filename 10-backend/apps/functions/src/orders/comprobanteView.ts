/**
 * orders/comprobanteView.ts — Enlace temporal para VER el comprobante (ORDER-COMPROBANTE-VIEW-1)
 * ==============================================================================================
 * Lógica PURA + deps inyectables (unit-testeable sin Storage). El callable (orderCallables)
 * hace auth de staff; acá se valida la referencia y se genera un enlace de lectura TEMPORAL:
 *   - la referencia debe ser EXACTAMENTE tenants/{tenantId}/orders/{orderId}/comprobantes/<archivo>
 *     (con el tenant y la orden YA autenticados — una referencia adulterada en Firestore no puede
 *     apuntar a otro tenant/orden ni escaparse con `..`);
 *   - `media:{id}` (descarga de Meta pendiente) y `comprobante-simulado` (dev) → error claro;
 *   - archivo inexistente → error claro;
 *   - la URL firmada NUNCA se persiste ni se loguea (el caller loguea solo orden + expiración).
 * El bucket sigue privado: en prod se firma (v4, corta duración); en el emulador se usa el
 * token de descarga del propio emulador (getSignedUrl no puede firmar sin credenciales reales).
 */
import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';

/** Duración del enlace: corta a propósito (el vendedor lo abre y listo). */
export const COMPROBANTE_URL_TTL_MS = 10 * 60 * 1000;

/** ¿La referencia es un path de Storage nuestro (no un fallback media:/simulado)? */
export function esComprobanteImagen(ref: string | null | undefined): boolean {
  return !!ref && ref.startsWith('tenants/');
}

/** Path EXACTO dentro de la carpeta de comprobantes de ESTA orden, con nombre de archivo simple. */
export function comprobantePathValido(tenantId: string, orderId: string, ref: string): boolean {
  const prefijo = `tenants/${tenantId}/orders/${orderId}/comprobantes/`;
  if (!ref.startsWith(prefijo)) return false;
  const archivo = ref.slice(prefijo.length);
  return /^[A-Za-z0-9._-]{1,200}$/.test(archivo) && !archivo.includes('..');
}

export type ComprobanteViewResult =
  | { ok: true; url: string; expiresAtMs: number }
  | { ok: false; code: 'failed-precondition' | 'not-found' | 'internal'; message: string };

export interface ComprobanteViewDeps {
  fileExists(path: string): Promise<boolean>;
  /** Devuelve una URL de LECTURA temporal. Lanza si no se puede firmar. */
  signUrl(path: string, expiresAtMs: number): Promise<string>;
}

/** Decisión completa (pura respecto de Storage): valida la referencia y pide la URL temporal. */
export async function resolveComprobanteView(
  tenantId: string,
  orderId: string,
  comprobanteUrl: string | null | undefined,
  deps: ComprobanteViewDeps,
  nowMs = Date.now(),
): Promise<ComprobanteViewResult> {
  const ref = (comprobanteUrl ?? '').trim();
  if (!ref) {
    return { ok: false, code: 'failed-precondition', message: 'Este pedido todavía no tiene comprobante.' };
  }
  if (!esComprobanteImagen(ref)) {
    // media:{id} (no se pudo descargar de Meta) o comprobante-simulado (dev).
    return {
      ok: false,
      code: 'failed-precondition',
      message: 'El comprobante llegó pero la imagen todavía no está disponible desde el panel.',
    };
  }
  if (!comprobantePathValido(tenantId, orderId, ref)) {
    return { ok: false, code: 'failed-precondition', message: 'La referencia del comprobante no es válida para este pedido.' };
  }
  if (!(await deps.fileExists(ref))) {
    return { ok: false, code: 'not-found', message: 'El archivo del comprobante no se encontró en el almacenamiento.' };
  }
  const expiresAtMs = nowMs + COMPROBANTE_URL_TTL_MS;
  try {
    return { ok: true, url: await deps.signUrl(ref, expiresAtMs), expiresAtMs };
  } catch {
    // Sin detalles del error hacia el cliente (podría traer metadata del bucket/SA).
    return { ok: false, code: 'internal', message: 'No se pudo generar el enlace seguro del comprobante.' };
  }
}

/** Deps reales: Storage del proyecto. Emulador → token URL; prod → signed URL v4 corta. */
export const defaultComprobanteViewDeps: ComprobanteViewDeps = {
  async fileExists(path) {
    const [exists] = await getStorage().bucket().file(path).exists();
    return exists;
  },
  async signUrl(path, expiresAtMs) {
    const bucket = getStorage().bucket();
    const file = bucket.file(path);
    const emuHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
    if (emuHost) {
      // El emulador no puede firmar (no hay clave privada): se usa su token de descarga.
      const [meta] = await file.getMetadata();
      const tokens = (meta.metadata?.firebaseStorageDownloadTokens as string | undefined) ?? '';
      let token = tokens.split(',').filter(Boolean)[0];
      if (!token) {
        token = randomUUID();
        await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
      }
      const host = emuHost.replace(/^https?:\/\//, '');
      return `http://${host}/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    }
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: expiresAtMs });
    return url;
  },
};
