/**
 * WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016) — Saneo de texto que viene del cliente/proveedor.
 * ==============================================================================================
 * El caption, el nombre de archivo y los mensajes de error son texto que NO controlamos y que
 * después se muestra en el panel, se guarda en Firestore y —en el caso del error— se loguea.
 * Estas funciones son la ÚNICA forma autorizada de prepararlos.
 *
 * Qué se saca y por qué:
 *  - Caracteres de control: rompen el render y permiten inyección de líneas en los logs.
 *  - Invisibles y marcas de dirección (zero-width, RTL override): permiten spoofing visual —
 *    un nombre que se ve `factura.pdf` y en realidad termina en `.exe`.
 *  - Separadores de ruta y `..` en el filename: path traversal. La defensa REAL es que la ruta
 *    de Storage se construye desde el `attachmentId` y jamás desde el nombre (ver
 *    `attachmentIdentity.ts`); esto es la segunda barrera.
 *  - Longitud acotada: un caption de 1 MB es un ataque de costo sobre Firestore y sobre el panel.
 *
 * Nota ADR-0016 §9: el caption se sanea y se persiste, pero NO se envía a la IA.
 */

/** Límite de caption de WhatsApp (1024). Alcanza y sobra para lo que muestra el panel. */
export const ATTACHMENT_CAPTION_MAX_LENGTH = 1024;
/** Nombre de archivo: decorativo, nunca se usa para construir rutas. */
export const ATTACHMENT_FILENAME_MAX_LENGTH = 120;
/** Error saneado: cabe en una fila del panel y en una línea de log. */
export const ATTACHMENT_ERROR_MAX_LENGTH = 300;

/** C0 + DEL + C1. Los caracteres de control son EL OBJETIVO de esta regex, no un descuido:
 *  son exactamente lo que hay que sacar del texto que llega del cliente/proveedor. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
/** Zero-width, joiners, marcas de dirección bidi y BOM. */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
/** Ilegales como nombre en Windows/GCS (más el `%` que confunde al ver rutas codificadas). */
const UNSAFE_NAME_RE = /[<>:"|?*]/g;

function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, '');
}

/**
 * Caption listo para persistir y renderizar. Siempre devuelve string (nunca `null`): el campo
 * `caption` del documento es obligatorio y el caso "sin caption" es `''`.
 * Los saltos de línea se colapsan a espacio a propósito: el panel lo muestra en una línea y así
 * el valor tampoco puede fabricar líneas falsas en un log.
 */
export function sanitizeAttachmentCaption(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let text = stripInvisible(raw.replace(CONTROL_RE, ' '));
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > ATTACHMENT_CAPTION_MAX_LENGTH) {
    text = text.slice(0, ATTACHMENT_CAPTION_MAX_LENGTH).trimEnd();
  }
  return text;
}

/**
 * Nombre de archivo saneado, o `null` si no queda nada usable. Conserva acentos y `ñ` (los
 * nombres reales en Paraguay los tienen): el riesgo no está en las letras sino en los
 * separadores, los invisibles y los controles, que sí se eliminan.
 */
export function sanitizeAttachmentFilename(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let name = stripInvisible(raw.replace(CONTROL_RE, ''));
  // Nos quedamos con el último segmento no vacío: mata `../../etc/passwd` y `C:\dir\x.pdf`.
  const segments = name.split(/[/\\]/).filter((segment) => segment !== '');
  name = segments.length > 0 ? (segments[segments.length - 1] as string) : '';
  name = name.replace(UNSAFE_NAME_RE, '_').replace(/\s+/g, ' ');
  // Puntos y espacios al borde: nombres ocultos, `..` puro y `archivo.` de Windows.
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (name.length > ATTACHMENT_FILENAME_MAX_LENGTH) {
    name = name.slice(0, ATTACHMENT_FILENAME_MAX_LENGTH).replace(/[\s.]+$/, '');
  }
  return name.length > 0 ? name : null;
}

/** URL completa (una URL firmada JAMÁS puede terminar persistida ni logueada). */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Corrida larga de dígitos: teléfonos, wamids numéricos, ids de media. */
const LONG_DIGITS_RE = /\d{7,}/g;

/**
 * Mensaje de error listo para `lastError` y para logs. Además del saneo de texto, tapa lo que
 * NUNCA puede salir: URLs (incluidas las firmadas de Graph y de Storage) y corridas largas de
 * dígitos (teléfono/mediaId). Es intencionalmente agresivo: perder detalle de un error cuesta
 * mucho menos que filtrar un identificador de un cliente.
 */
export function sanitizeAttachmentError(raw: unknown, maxLength = ATTACHMENT_ERROR_MAX_LENGTH): string {
  if (raw === null || raw === undefined) return '';
  const base = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  if (base.length === 0) return '';
  let text = stripInvisible(base.replace(CONTROL_RE, ' '));
  text = text.replace(URL_RE, '[url]').replace(LONG_DIGITS_RE, '[num]');
  text = text.replace(/\s+/g, ' ').trim();
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : ATTACHMENT_ERROR_MAX_LENGTH;
  if (text.length > limit) text = text.slice(0, limit).trimEnd();
  return text;
}
