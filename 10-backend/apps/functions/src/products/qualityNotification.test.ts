import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { decideCatalogQualityPatch } from './qualityNotification.js';

/**
 * C8 de la review HARDEN-1: la campana agregada no tenía NINGUNA cobertura. La decisión
 * es pura (extraída a decideCatalogQualityPatch); la escritura es best-effort declarada
 * (ADR-0014 §4b) y el E2E cubre el circuito completo (CO-21/22, HD-2f).
 */
const now = Timestamp.fromMillis(1_800_000_000_000);
const T = 'tenant-x';

describe('decideCatalogQualityPatch — campana agregada idempotente', () => {
  it('refresh normal sin doc previo ⇒ crea el aviso abierto con contadores reales', () => {
    const p = decideCatalogQualityPatch(T, { blocking: 3, warning: 1, truncated: false }, undefined, now)!;
    expect(p.category).toBe('catalog_quality');
    expect(p.dedupeKey).toBe(`catalog-quality-${T}`);
    expect(p.blockingCount).toBe(3);
    expect(p.read).toBe(false);
    expect(p.resolvedAt).toBeNull();
  });

  it('en 0/0 SIN doc previo ⇒ null (jamás se crea un aviso vacío)', () => {
    expect(decideCatalogQualityPatch(T, { blocking: 0, warning: 0, truncated: false }, undefined, now)).toBeNull();
  });

  it('AUTOCIERRE: 0/0 con aviso abierto ⇒ read+resolvedAt; ya resuelto ⇒ null', () => {
    const abierto = { blockingCount: 5, read: false, resolvedAt: null };
    const p = decideCatalogQualityPatch(T, { blocking: 0, warning: 0, truncated: false }, abierto, now)!;
    expect(p.resolvedAt).toBe(now);
    expect(p.read).toBe(true);
    expect(p.blockingCount).toBe(0);
    expect(decideCatalogQualityPatch(T, { blocking: 0, warning: 0, truncated: false }, { resolvedAt: now }, now)).toBeNull();
  });

  it('REAPERTURA solo al SUBIR los bloqueos de un aviso ya leído; bajar no despierta', () => {
    const leido = { blockingCount: 3, read: true, resolvedAt: null };
    const sube = decideCatalogQualityPatch(T, { blocking: 5, warning: 0, truncated: false }, leido, now)!;
    expect(sube.read).toBe(false);
    const baja = decideCatalogQualityPatch(T, { blocking: 2, warning: 0, truncated: false }, leido, now)!;
    expect('read' in baja).toBe(false); // actualiza contadores sin despertar
    expect(baja.blockingCount).toBe(2);
  });

  it('createdAt se preserva del aviso previo (no se reinicia la antigüedad)', () => {
    const antes = Timestamp.fromMillis(1_700_000_000_000);
    const p = decideCatalogQualityPatch(T, { blocking: 1, warning: 0, truncated: false }, { createdAt: antes, read: false }, now)!;
    expect(p.createdAt).toBe(antes);
  });

  it('truncated ⇒ el texto dice "o más" (tope honesto, sin números inventados)', () => {
    const p = decideCatalogQualityPatch(T, { blocking: 500, warning: 500, truncated: true }, undefined, now)!;
    expect(String(p.body)).toContain('500 o más');
  });
});
