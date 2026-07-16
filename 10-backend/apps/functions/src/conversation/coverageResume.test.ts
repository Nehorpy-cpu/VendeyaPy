import { describe, it, expect } from 'vitest';
import {
  direccionTextualDe,
  MENSAJE_COBERTURA_APROBADA_INTRO,
  MENSAJE_COBERTURA_RECHAZADA_DEFAULT,
  MENSAJE_CARRITO_VACIO_APROBADO,
  MENSAJE_COBERTURA_VENCIDA,
} from './coverageResume.js';
import type { CoverageRequest } from '@vpw/shared';

/**
 * COVERAGE-1D: partes PURAS del consumidor. El ciclo completo (claim, held, orden única,
 * outbox de mensajería, expiración, purga) se verifica en scripts/verify-coverage-resume.mjs.
 */
describe('coverageResume direccionTextualDe — dirección TEXTUAL, jamás coordenadas', () => {
  it('copia SOLO addressText; coordinates null y el name del lugar NO viaja (la purga no alcanza órdenes)', () => {
    const req = {
      location: {
        source: 'whatsapp_location',
        addressText: 'Av. Test 123, Luque',
        name: 'Casa Flia. Test',
        coordinates: { lat: -25.28, lng: -57.64 },
      },
    } as unknown as Pick<CoverageRequest, 'location'>;
    const dir = direccionTextualDe(req);
    expect(dir.street).toBe('Av. Test 123, Luque');
    expect(dir.reference).toBe('');
    expect(dir.coordinates).toBeNull();
    expect(JSON.stringify(dir)).not.toContain('-25.28');
    expect(JSON.stringify(dir)).not.toContain('Flia');
  });

  it('sin ubicación → dirección vacía segura (nunca lanza)', () => {
    const dir = direccionTextualDe({ location: null } as Pick<CoverageRequest, 'location'>);
    expect(dir.street).toBe('');
    expect(dir.coordinates).toBeNull();
  });

  it('tope de longitud: street ≤512, reference ≤128', () => {
    const dir = direccionTextualDe({
      location: { source: 'text', addressText: 'x'.repeat(2000), name: 'y'.repeat(500), coordinates: null },
    } as Pick<CoverageRequest, 'location'>);
    expect(dir.street).toHaveLength(512);
    expect(dir.reference).toBe('');
  });
});

describe('coverageResume — mensajes seguros', () => {
  it('el rechazo default es honesto e invita a otra dirección, sin nota interna ni promesas', () => {
    expect(MENSAJE_COBERTURA_RECHAZADA_DEFAULT).toContain('no podemos confirmar cobertura');
    expect(MENSAJE_COBERTURA_RECHAZADA_DEFAULT).toContain('otra dirección');
    expect(MENSAJE_COBERTURA_RECHAZADA_DEFAULT).not.toMatch(/nota|zona sin|te paso con/i);
  });

  it('aprobado/vacío/vencido: sin datos bancarios embebidos ni afirmaciones de pago', () => {
    for (const m of [MENSAJE_COBERTURA_APROBADA_INTRO, MENSAJE_CARRITO_VACIO_APROBADO, MENSAJE_COBERTURA_VENCIDA]) {
      expect(m).not.toMatch(/cuenta|CI\/RUC|pagado|PAID/i);
    }
  });
});
