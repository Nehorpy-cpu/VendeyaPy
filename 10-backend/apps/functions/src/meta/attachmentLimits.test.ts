import { describe, it, expect } from 'vitest';

/**
 * ADR-0016 §8 — «Los formatos admitidos … son configuración por tenant, no ramas en el código».
 * Un tenant puede RESTRINGIR; jamás ampliar más allá de lo que el sniffing sabe verificar.
 */
import {
  parseAttachmentIngestLimits,
  DEFAULT_ATTACHMENT_LIMITS,
  ATTACHMENT_MIN_MAX_BYTES,
  ATTACHMENT_MAX_MAX_BYTES,
} from './attachmentLimits.js';
import { ATTACHMENT_ALLOWED_MIME_TYPES } from '@vpw/shared';

describe('parseAttachmentIngestLimits — fail-closed en los dos sentidos', () => {
  it('sin config, defaults del código', () => {
    expect(parseAttachmentIngestLimits(undefined)).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    expect(parseAttachmentIngestLimits(null)).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    expect(parseAttachmentIngestLimits('10MB')).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    expect(parseAttachmentIngestLimits([])).toEqual(DEFAULT_ATTACHMENT_LIMITS);
  });

  it('el tenant puede BAJAR el tope de bytes', () => {
    expect(parseAttachmentIngestLimits({ maxBytes: 1_000_000 }).maxBytes).toBe(1_000_000);
  });

  it('pero NO puede subirlo por encima del techo del código (ni bajarlo a cero)', () => {
    expect(parseAttachmentIngestLimits({ maxBytes: 2 * 1024 * 1024 * 1024 }).maxBytes).toBe(ATTACHMENT_MAX_MAX_BYTES);
    expect(parseAttachmentIngestLimits({ maxBytes: 1 }).maxBytes).toBe(ATTACHMENT_MIN_MAX_BYTES);
    expect(parseAttachmentIngestLimits({ maxBytes: -5 }).maxBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxBytes);
    expect(parseAttachmentIngestLimits({ maxBytes: 'muchos' }).maxBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxBytes);
  });

  it('el tenant puede restringir formatos (p. ej. solo PDF)', () => {
    expect(parseAttachmentIngestLimits({ allowedMimeTypes: ['application/pdf'] }).allowedMimeTypes).toEqual([
      'application/pdf',
    ]);
  });

  it('un formato INVENTADO no se habilita: la lista se interseca con la whitelist compartida', () => {
    const r = parseAttachmentIngestLimits({ allowedMimeTypes: ['image/svg+xml', 'text/html', 'image/png'] });
    expect(r.allowedMimeTypes).toEqual(['image/png']);
    expect(r.allowedMimeTypes).not.toContain('image/svg+xml');
  });

  it('una lista que queda VACÍA cae al default en vez de negar todo en silencio', () => {
    expect(parseAttachmentIngestLimits({ allowedMimeTypes: ['application/x-inventado'] }).allowedMimeTypes).toEqual(
      ATTACHMENT_ALLOWED_MIME_TYPES,
    );
    expect(parseAttachmentIngestLimits({ allowedMimeTypes: [] }).allowedMimeTypes).toEqual(
      ATTACHMENT_ALLOWED_MIME_TYPES,
    );
  });
});
