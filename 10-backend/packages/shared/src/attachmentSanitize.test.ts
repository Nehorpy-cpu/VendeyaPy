import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_CAPTION_MAX_LENGTH,
  ATTACHMENT_ERROR_MAX_LENGTH,
  ATTACHMENT_FILENAME_MAX_LENGTH,
  sanitizeAttachmentCaption,
  sanitizeAttachmentError,
  sanitizeAttachmentFilename,
} from './attachmentSanitize.js';

describe('sanitizeAttachmentCaption', () => {
  it('conserva el texto normal del cliente (acentos incluidos)', () => {
    expect(sanitizeAttachmentCaption('Hola, ¿tenés este perfume en 100ml?')).toBe(
      'Hola, ¿tenés este perfume en 100ml?',
    );
  });

  it('saca caracteres de control y colapsa saltos de línea', () => {
    expect(sanitizeAttachmentCaption('linea1\nlinea2\r\n\tlinea3')).toBe('linea1 linea2 linea3');
    expect(sanitizeAttachmentCaption('a\u0000\u0007b')).toBe('a b');
  });

  it('saca invisibles y marcas bidi (spoofing visual)', () => {
    expect(sanitizeAttachmentCaption('fac\u200Btura\u202Egpj.exe')).toBe('facturagpj.exe');
    expect(sanitizeAttachmentCaption('\uFEFFhola')).toBe('hola');
  });

  it('acota la longitud', () => {
    const out = sanitizeAttachmentCaption('x'.repeat(ATTACHMENT_CAPTION_MAX_LENGTH + 500));
    expect(out.length).toBe(ATTACHMENT_CAPTION_MAX_LENGTH);
  });

  it('sin caption ⇒ string vacío, nunca null/undefined', () => {
    for (const bad of [undefined, null, 42, {}, '', '   ', '\u0000']) {
      expect(sanitizeAttachmentCaption(bad)).toBe('');
    }
  });
});

describe('sanitizeAttachmentFilename', () => {
  it('conserva nombres reales con acentos y ñ', () => {
    expect(sanitizeAttachmentFilename('Comprobante Añasco 2026.pdf')).toBe(
      'Comprobante Añasco 2026.pdf',
    );
  });

  it('corta cualquier ruta (traversal POSIX y Windows)', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('C:\\Windows\\system32\\evil.exe')).toBe('evil.exe');
    expect(sanitizeAttachmentFilename('/absoluto/comprobante.pdf')).toBe('comprobante.pdf');
    expect(sanitizeAttachmentFilename('a/b/../c/factura.pdf')).toBe('factura.pdf');
  });

  it('neutraliza nombres degenerados', () => {
    for (const bad of ['..', '.', '...', '   ', '/', '\\', '', undefined, null, 7]) {
      expect(sanitizeAttachmentFilename(bad)).toBeNull();
    }
    expect(sanitizeAttachmentFilename('.oculto')).toBe('oculto');
    expect(sanitizeAttachmentFilename('archivo.')).toBe('archivo');
  });

  it('reemplaza caracteres ilegales y saca invisibles/controles', () => {
    // 7 ilegales: < > : " | ? *  ⇒ 7 guiones bajos, ninguno se pierde ni se colapsa.
    expect(sanitizeAttachmentFilename('fac<tu>ra:"|?*.pdf')).toBe('fac_tu_ra_____.pdf');
    expect(sanitizeAttachmentFilename('fact\u0000ura\u200B.pdf')).toBe('factura.pdf');
    expect(sanitizeAttachmentFilename('recibo\u202Efdp.exe')).toBe('recibofdp.exe');
  });

  it('acota la longitud sin dejar puntos ni espacios al final', () => {
    const out = sanitizeAttachmentFilename(`${'n'.repeat(300)}.pdf`);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(ATTACHMENT_FILENAME_MAX_LENGTH);
    expect(out as string).toMatch(/[^\s.]$/);
  });
});

describe('sanitizeAttachmentError', () => {
  it('tapa URLs (una firmada JAMÁS puede quedar persistida)', () => {
    expect(
      sanitizeAttachmentError('fallo al bajar https://lookaside.fbsbx.com/x?token=abc123 (403)'),
    ).toBe('fallo al bajar [url] (403)');
    expect(sanitizeAttachmentError('gs://bucket/tenants/t/attachments/ab/att_x')).toBe('[url]');
  });

  it('tapa corridas largas de dígitos (teléfono / mediaId)', () => {
    const out = sanitizeAttachmentError('media 1234567890123456 del cliente 595981122334');
    expect(out).toBe('media [num] del cliente [num]');
    expect(out).not.toContain('595981122334');
  });

  it('acepta Error y string, y colapsa control chars', () => {
    expect(sanitizeAttachmentError(new Error('timeout\nreintentar'))).toBe('timeout reintentar');
    expect(sanitizeAttachmentError('  a\tb  ')).toBe('a b');
  });

  it('acota la longitud y tolera un límite inválido', () => {
    expect(sanitizeAttachmentError('e'.repeat(1000)).length).toBe(ATTACHMENT_ERROR_MAX_LENGTH);
    expect(sanitizeAttachmentError('e'.repeat(1000), -5).length).toBe(ATTACHMENT_ERROR_MAX_LENGTH);
    expect(sanitizeAttachmentError('abcdef', 3)).toBe('abc');
  });

  it('sin error ⇒ string vacío', () => {
    for (const bad of [undefined, null, '', {}, 42]) {
      expect(sanitizeAttachmentError(bad)).toBe('');
    }
  });
});
