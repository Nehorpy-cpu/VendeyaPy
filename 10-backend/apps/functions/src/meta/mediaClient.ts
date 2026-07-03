/**
 * meta/mediaClient.ts — Descarga de media de WhatsApp Cloud API (ORDER-1B)
 * ========================================================================
 * Dos pasos contra Graph: (1) GET /{mediaId} → metadata {url, mime_type, file_size};
 * (2) GET url → binario. Ambos con el access token DEL TENANT (resuelto por el caller
 * vía resolveTenantWhatsappCreds; nunca se persiste ni se loguea).
 *
 * Límites ANTES de descargar el contenido: solo imágenes (jpeg/png/webp) y ≤10 MB.
 * NUNCA loguear el token ni la URL firmada de Meta (lookaside.fbsbx.com lleva firma).
 */
import { logger } from '../lib/logger.js';

const GRAPH_VERSION = 'v19.0';
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extensionForMime(mimeType: string): string | null {
  return ALLOWED_MIME[mimeType] ?? null;
}

export type MediaDownloadResult =
  | { ok: true; buffer: Buffer; mimeType: string; bytes: number }
  | { ok: false; reason: 'unsupported_type' | 'too_large' | 'fetch_failed' };

export async function downloadWhatsappMedia(mediaId: string, accessToken: string): Promise<MediaDownloadResult> {
  try {
    // 1) Metadata del media (mime + tamaño + URL efímera firmada).
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
      logger.warn('mediaClient: metadata del media falló', { mediaId, status: metaRes.status });
      return { ok: false, reason: 'fetch_failed' };
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
    const mimeType = meta.mime_type ?? '';
    if (!extensionForMime(mimeType)) {
      logger.info('mediaClient: tipo de media no soportado para comprobante', { mediaId, mimeType });
      return { ok: false, reason: 'unsupported_type' };
    }
    if ((meta.file_size ?? 0) > MAX_MEDIA_BYTES) {
      logger.info('mediaClient: media demasiado grande', { mediaId, bytes: meta.file_size });
      return { ok: false, reason: 'too_large' };
    }
    if (!meta.url) return { ok: false, reason: 'fetch_failed' };

    // 2) Contenido. La URL es firmada/efímera: no se loguea ni se persiste.
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!binRes.ok) {
      logger.warn('mediaClient: descarga del contenido falló', { mediaId, status: binRes.status });
      return { ok: false, reason: 'fetch_failed' };
    }
    const buffer = Buffer.from(await binRes.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) return { ok: false, reason: 'too_large' }; // defensa extra
    return { ok: true, buffer, mimeType, bytes: buffer.length };
  } catch (e) {
    logger.warn('mediaClient: excepción descargando media', { mediaId, error: e instanceof Error ? e.name : 'unknown' });
    return { ok: false, reason: 'fetch_failed' };
  }
}
