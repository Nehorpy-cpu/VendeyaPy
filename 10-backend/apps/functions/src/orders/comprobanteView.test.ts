/**
 * comprobanteView.test.ts — Enlace temporal del comprobante (ORDER-COMPROBANTE-VIEW-1)
 * Cubre los tests backend del programa: path whitelist, referencias no-imagen, archivo
 * inexistente, firma fallida sin filtrar detalles, y que la URL nunca viaja en el error.
 * (La autorización staff/cross-tenant/admin la cubre assertStaffAccess + el E2E.)
 */
import { describe, it, expect } from 'vitest';
import {
  comprobantePathValido,
  esComprobanteImagen,
  resolveComprobanteView,
  COMPROBANTE_URL_TTL_MS,
  type ComprobanteViewDeps,
} from './comprobanteView.js';

const T = 'arfagi';
const O = 'ord_123';
const PATH_OK = `tenants/${T}/orders/${O}/comprobantes/wamid.ABC-123.jpg`;

const deps = (over: Partial<ComprobanteViewDeps> = {}): ComprobanteViewDeps => ({
  fileExists: async () => true,
  signUrl: async (path, exp) => `https://signed.example/${encodeURIComponent(path)}?exp=${exp}`,
  ...over,
});

describe('comprobantePathValido — whitelist estricta del path', () => {
  it('acepta solo la carpeta de comprobantes de ESTA orden', () => {
    expect(comprobantePathValido(T, O, PATH_OK)).toBe(true);
  });
  it('rechaza otra orden, otro tenant, traversal y subcarpetas', () => {
    expect(comprobantePathValido(T, O, `tenants/${T}/orders/OTRA/comprobantes/x.jpg`)).toBe(false);
    expect(comprobantePathValido(T, O, `tenants/otro-tenant/orders/${O}/comprobantes/x.jpg`)).toBe(false);
    expect(comprobantePathValido(T, O, `tenants/${T}/orders/${O}/comprobantes/../../../secreto.jpg`)).toBe(false);
    expect(comprobantePathValido(T, O, `tenants/${T}/orders/${O}/comprobantes/sub/x.jpg`)).toBe(false);
    expect(comprobantePathValido(T, O, `tenants/${T}/products/p1/foto.jpg`)).toBe(false);
    expect(comprobantePathValido(T, O, '')).toBe(false);
  });
});

describe('resolveComprobanteView', () => {
  it('feliz: URL temporal con expiración corta; nunca se persiste nada', async () => {
    const r = await resolveComprobanteView(T, O, PATH_OK, deps(), 1_000_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toContain('signed.example');
    expect(r.expiresAtMs).toBe(1_000_000 + COMPROBANTE_URL_TTL_MS);
  });

  it('sin comprobante → error claro (failed-precondition)', async () => {
    const r = await resolveComprobanteView(T, O, null, deps());
    expect(r).toMatchObject({ ok: false, code: 'failed-precondition' });
    if (!r.ok) expect(r.message).toContain('todavía no tiene comprobante');
  });

  it('media:{id} y comprobante-simulado → "imagen no disponible", no intenta Storage', async () => {
    let touched = false;
    const d = deps({ fileExists: async () => { touched = true; return true; } });
    for (const ref of ['media:MEDIA123', 'comprobante-simulado']) {
      const r = await resolveComprobanteView(T, O, ref, d);
      expect(r).toMatchObject({ ok: false, code: 'failed-precondition' });
      if (!r.ok) expect(r.message).toContain('no está disponible');
    }
    expect(touched).toBe(false);
    expect(esComprobanteImagen('media:X')).toBe(false);
    expect(esComprobanteImagen(PATH_OK)).toBe(true);
  });

  it('referencia fuera del patrón (adulterada en Firestore) → rechazo sin tocar Storage', async () => {
    let touched = false;
    const d = deps({ fileExists: async () => { touched = true; return true; } });
    const r = await resolveComprobanteView(T, O, `tenants/otro/orders/${O}/comprobantes/x.jpg`, d);
    expect(r).toMatchObject({ ok: false, code: 'failed-precondition' });
    expect(touched).toBe(false);
  });

  it('archivo inexistente → not-found con mensaje claro', async () => {
    const r = await resolveComprobanteView(T, O, PATH_OK, deps({ fileExists: async () => false }));
    expect(r).toMatchObject({ ok: false, code: 'not-found' });
    if (!r.ok) expect(r.message).toContain('no se encontró');
  });

  it('falla de firma → internal SIN filtrar detalles del error (ni bucket ni SA)', async () => {
    const r = await resolveComprobanteView(T, O, PATH_OK, deps({
      signUrl: async () => { throw new Error('client_email missing for bucket gs://super-secreto'); },
    }));
    expect(r).toMatchObject({ ok: false, code: 'internal' });
    if (!r.ok) {
      expect(r.message).not.toContain('secreto');
      expect(r.message).not.toContain('client_email');
    }
  });
});
