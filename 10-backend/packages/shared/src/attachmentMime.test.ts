import { describe, it, expect } from 'vitest';
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_SNIFF_MIN_BYTES,
  attachmentClassForMime,
  declaredMimeMatchesVerified,
  isAllowedAttachmentMime,
  normalizeMimeType,
  sniffAttachmentMime,
} from './attachmentMime.js';
import { utf8Bytes } from './sha256.js';

const bytes = (...values: (number | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') out.push(value);
    else out.push(...Array.from(utf8Bytes(value)));
  }
  return Uint8Array.from(out);
};

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'JFIF', 0x00, 0x01);
const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 'IHDR');
const WEBP = bytes('RIFF', 0x24, 0x00, 0x00, 0x00, 'WEBPVP8 ');
const PDF = bytes('%PDF-1.7\n%\xe2\xe3');

describe('sniffAttachmentMime — formatos admitidos', () => {
  it('reconoce JPEG, PNG, WebP y PDF por magic bytes', () => {
    expect(sniffAttachmentMime(JPEG)).toBe('image/jpeg');
    expect(sniffAttachmentMime(PNG)).toBe('image/png');
    expect(sniffAttachmentMime(WEBP)).toBe('image/webp');
    expect(sniffAttachmentMime(PDF)).toBe('application/pdf');
  });

  it('el mínimo declarado alcanza para decidir WebP (la firma más larga)', () => {
    expect(ATTACHMENT_SNIFF_MIN_BYTES).toBe(12);
    expect(sniffAttachmentMime(WEBP.slice(0, ATTACHMENT_SNIFF_MIN_BYTES))).toBe('image/webp');
  });

  it('cubre exactamente los cuatro formatos declarados', () => {
    expect([...ATTACHMENT_ALLOWED_MIME_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
    ]);
  });
});

describe('sniffAttachmentMime — casos hostiles', () => {
  it('POLYGLOT: un "JPEG" que empieza como HTML se rechaza (la firma se exige en offset 0)', () => {
    const polyglot = bytes('<html><!--', 0xff, 0xd8, 0xff, 0xe0, '-->');
    expect(sniffAttachmentMime(polyglot)).toBeNull();
  });

  it('POLYGLOT: PDF con basura adelante también se rechaza', () => {
    expect(sniffAttachmentMime(bytes('\n\n', '%PDF-1.4'))).toBeNull();
    expect(sniffAttachmentMime(bytes(0xef, 0xbb, 0xbf, '%PDF-1.4'))).toBeNull(); // con BOM
  });

  it('SVG (con y sin prólogo XML) ⇒ null', () => {
    expect(sniffAttachmentMime(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script/>'))).toBeNull();
    expect(sniffAttachmentMime(bytes('<?xml version="1.0"?><svg>'))).toBeNull();
  });

  it('HTML ⇒ null', () => {
    expect(sniffAttachmentMime(bytes('<!DOCTYPE html><html><body>'))).toBeNull();
    expect(sniffAttachmentMime(bytes('<html>'))).toBeNull();
  });

  it('ejecutables (PE/MZ, ELF, Mach-O, script con shebang) ⇒ null', () => {
    expect(sniffAttachmentMime(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03))).toBeNull();
    expect(sniffAttachmentMime(bytes(0x7f, 'ELF', 0x02, 0x01))).toBeNull();
    expect(sniffAttachmentMime(bytes(0xcf, 0xfa, 0xed, 0xfe, 0x07))).toBeNull();
    expect(sniffAttachmentMime(bytes('#!/bin/sh\nrm -rf'))).toBeNull();
  });

  it('RIFF que NO es WebP (p. ej. WAV) ⇒ null: el segundo bloque es obligatorio', () => {
    expect(sniffAttachmentMime(bytes('RIFF', 0x24, 0x00, 0x00, 0x00, 'WAVEfmt '))).toBeNull();
  });

  it('formatos no admitidos hoy (GIF, ZIP/Office) ⇒ null', () => {
    expect(sniffAttachmentMime(bytes('GIF89a'))).toBeNull();
    expect(sniffAttachmentMime(bytes('PK', 0x03, 0x04))).toBeNull();
  });

  it('entrada vacía, truncada o ausente ⇒ null (fail-closed)', () => {
    expect(sniffAttachmentMime(new Uint8Array(0))).toBeNull();
    expect(sniffAttachmentMime(Uint8Array.from([0xff, 0xd8]))).toBeNull(); // JPEG cortado
    expect(sniffAttachmentMime(bytes('RIFF'))).toBeNull(); // sin el bloque WEBP
    expect(sniffAttachmentMime(null)).toBeNull();
    expect(sniffAttachmentMime(undefined)).toBeNull();
  });
});

describe('normalizeMimeType / isAllowedAttachmentMime', () => {
  it('normaliza mayúsculas, espacios y parámetros', () => {
    expect(normalizeMimeType('IMAGE/JPEG')).toBe('image/jpeg');
    expect(normalizeMimeType(' image/jpeg; charset=binary ')).toBe('image/jpeg');
  });

  it('rechaza basura', () => {
    for (const bad of ['', 'imagen', 'image/', '/jpeg', 'a'.repeat(200), null, 42, {}]) {
      expect(normalizeMimeType(bad)).toBeNull();
    }
  });

  it('whitelist cerrada', () => {
    expect(isAllowedAttachmentMime('application/pdf')).toBe(true);
    expect(isAllowedAttachmentMime('image/svg+xml')).toBe(false);
    expect(isAllowedAttachmentMime('IMAGE/JPEG')).toBe(false); // ya normalizado, o nada
    expect(isAllowedAttachmentMime(undefined)).toBe(false);
  });
});

describe('declaredMimeMatchesVerified', () => {
  it('tolera alias del lado declarado', () => {
    expect(declaredMimeMatchesVerified('image/jpg', 'image/jpeg')).toBe(true);
    expect(declaredMimeMatchesVerified('IMAGE/JPEG; charset=x', 'image/jpeg')).toBe(true);
  });

  it('detecta la mentira del proveedor', () => {
    expect(declaredMimeMatchesVerified('image/png', 'image/jpeg')).toBe(false);
    expect(declaredMimeMatchesVerified('image/jpeg', 'application/pdf')).toBe(false);
    expect(declaredMimeMatchesVerified(null, 'image/jpeg')).toBe(false);
    expect(declaredMimeMatchesVerified('image/jpeg', null)).toBe(false);
  });
});

describe('attachmentClassForMime', () => {
  it('mapea solo la whitelist', () => {
    expect(attachmentClassForMime('image/jpeg')).toBe('image');
    expect(attachmentClassForMime('image/png')).toBe('image');
    expect(attachmentClassForMime('image/webp')).toBe('image');
    expect(attachmentClassForMime('application/pdf')).toBe('document');
  });

  it('todo lo demás es unknown — incluido SVG, que "parece" imagen', () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/zip', '', null, undefined, 7]) {
      expect(attachmentClassForMime(mime)).toBe('unknown');
    }
  });
});
