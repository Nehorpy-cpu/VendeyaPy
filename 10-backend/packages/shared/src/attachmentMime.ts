/**
 * WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016) — Formatos admitidos y sniffing por magic bytes.
 * ============================================================================================
 * POR QUÉ existe este módulo: el MIME que declara Graph NO se cree. Un atacante controla el
 * archivo y (parcialmente) lo que el proveedor declara; si guardáramos por el `mime` declarado,
 * un HTML o un SVG con script podría terminar servido desde una URL firmada de nuestro bucket y
 * ejecutarse en el navegador del vendedor con nuestra sesión abierta.
 *
 * Es una WHITELIST cerrada: lo que no matchea exactamente una firma conocida devuelve `null` y
 * el adjunto se rechaza. SVG, HTML y ejecutables no están en la lista, así que caen solos — pero
 * igual están cubiertos por test, porque son el caso hostil que motiva la función.
 *
 * La firma se exige en el OFFSET 0 (salvo el segundo bloque de WebP, que el formato define en 8).
 * Tolerar basura adelante sería aceptar polyglots: un archivo que empieza como HTML —y que el
 * navegador va a interpretar como HTML— pero que unos bytes más abajo tiene la firma JPEG.
 *
 * Todo puro: recibe los primeros bytes y no toca red, disco ni logs.
 */

import type { AttachmentClass } from './types/attachment.types.js';

/**
 * Formatos iniciales. Los tres de imagen son los que manda WhatsApp desde la cámara/galería y el
 * PDF es el formato en que las apps bancarias mandan los comprobantes (defecto #3 de la
 * auditoría: los PDF se descartaban en silencio). Ampliarlo es configuración por tenant sobre
 * ESTE conjunto, nunca una rama por vertical.
 */
export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type AttachmentAllowedMime = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export interface AttachmentMagicSignature {
  readonly mime: AttachmentAllowedMime;
  readonly offset: number;
  readonly bytes: readonly number[];
  /** Segundo bloque obligatorio (WebP: 'WEBP' en el offset 8, después del tamaño RIFF). */
  readonly second?: { readonly offset: number; readonly bytes: readonly number[] };
}

export const ATTACHMENT_MAGIC_SIGNATURES: readonly AttachmentMagicSignature[] = [
  // SOI + primer marcador. JFIF/Exif/raw comparten estos 3 bytes.
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // \x89 P N G \r \n \x1a \n
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // 'RIFF' ....(tamaño) 'WEBP' — sin el segundo bloque sería cualquier RIFF (p. ej. un WAV).
  {
    mime: 'image/webp',
    offset: 0,
    bytes: [0x52, 0x49, 0x46, 0x46],
    second: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  },
  // '%PDF-'
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/** Bytes mínimos que hay que leer para poder decidir (los que necesita la firma más larga: WebP). */
export const ATTACHMENT_SNIFF_MIN_BYTES = 12;

function matchesAt(head: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (head.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (head[offset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * MIME REAL a partir de los primeros bytes, o `null` si no es un formato admitido.
 * Fail-closed: entrada vacía, corta o desconocida ⇒ `null` ⇒ el caller rechaza el adjunto.
 */
export function sniffAttachmentMime(
  head: Uint8Array | null | undefined,
): AttachmentAllowedMime | null {
  if (!head || typeof head.length !== 'number' || head.length === 0) return null;
  for (const signature of ATTACHMENT_MAGIC_SIGNATURES) {
    if (!matchesAt(head, signature.offset, signature.bytes)) continue;
    if (signature.second && !matchesAt(head, signature.second.offset, signature.second.bytes)) {
      continue;
    }
    return signature.mime;
  }
  return null;
}

export function isAllowedAttachmentMime(value: unknown): value is AttachmentAllowedMime {
  return (
    typeof value === 'string' &&
    (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Normaliza un MIME declarado: minúsculas, sin parámetros (`; charset=…`), sin espacios.
 * Se usa SOLO para guardar `mime.declared` prolijo y para comparar contra el verificado; nunca
 * para decidir si el archivo se acepta.
 */
export function normalizeMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.length === 0 || base.length > 128) return null;
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)) return null;
  return base;
}

/** Alias tolerados SOLO del lado declarado (Graph y algunos clientes mandan `image/jpg`). */
const DECLARED_ALIASES: Readonly<Record<string, AttachmentAllowedMime>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'application/x-pdf': 'application/pdf',
};

/**
 * ¿Lo declarado coincide con lo verificado? Un `false` NO es motivo de rechazo por sí solo
 * (manda lo verificado), pero es señal de que el proveedor o el cliente mintieron: sirve para
 * métricas y para el `lastError` saneado.
 */
export function declaredMimeMatchesVerified(declared: unknown, verified: unknown): boolean {
  const normalizedDeclared = normalizeMimeType(declared);
  const normalizedVerified = normalizeMimeType(verified);
  if (!normalizedDeclared || !normalizedVerified) return false;
  const resolved = DECLARED_ALIASES[normalizedDeclared] ?? normalizedDeclared;
  return resolved === normalizedVerified;
}

/**
 * Clase técnica del adjunto. Solo mapea MIMEs de la whitelist: cualquier otra cosa —incluido
 * `image/svg+xml`, que "parece" imagen— es `unknown`, para que nunca se renderice como imagen.
 */
export function attachmentClassForMime(mime: unknown): AttachmentClass {
  const normalized = normalizeMimeType(mime);
  if (!normalized || !isAllowedAttachmentMime(normalized)) return 'unknown';
  return normalized === 'application/pdf' ? 'document' : 'image';
}
