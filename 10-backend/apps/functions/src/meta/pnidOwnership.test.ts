/**
 * pnidOwnership.test.ts — la decisión PURA de propiedad de un phone_number_id.
 *
 * El guard vivía duplicado en dos caminos (alta manual y número adicional) y AUSENTE en el tercero
 * (Embedded Signup). Dos copias de la misma regla terminan divergiendo, y la laxa es la que deja
 * pasar. Acá vive la única decisión; los caminos solo la aplican.
 */
import { describe, it, expect } from 'vitest';
import { pnidEstaLibre, PnidOcupadoError, whatsappIndexId } from './pnidOwnership.js';

const TENANT = 'tnt_alpha';

describe('pnidEstaLibre', () => {
  it('sin dueño → libre', () => {
    expect(pnidEstaLibre(TENANT, null)).toBe(true);
  });

  it('dueño = el mismo tenant → libre (reconectar es idempotente)', () => {
    expect(pnidEstaLibre(TENANT, TENANT)).toBe(true);
  });

  it('dueño = otro tenant → OCUPADO (jamás secuestrar los webhooks de otro negocio)', () => {
    expect(pnidEstaLibre(TENANT, 'tnt_beta')).toBe(false);
  });

  it('una entrada de índice sin tenantId no habilita a nadie: se trata como ajena', () => {
    // Fail-closed: un índice corrupto o a medio escribir no puede leerse como «libre», porque el
    // desenlace de equivocarse es quedarse con el ruteo de otro negocio.
    expect(pnidEstaLibre(TENANT, '')).toBe(false);
  });
});

describe('whatsappIndexId', () => {
  it('es la MISMA clave que usa el índice global (si divergiera, el guard miraría otro documento)', () => {
    expect(whatsappIndexId('111222333')).toBe('whatsapp_111222333');
  });
});

describe('PnidOcupadoError', () => {
  it('lleva el dueño en conflicto para que el callable pueda explicarlo', () => {
    const e = new PnidOcupadoError('111222333', 'tnt_beta');
    expect(e.conflictTenantId).toBe('tnt_beta');
    expect(e.pnid).toBe('111222333');
    expect(e).toBeInstanceOf(Error);
  });
});
