import { describe, it, expect } from 'vitest';
import {
  direccionTextualDe,
  avisoReanudacionBloqueada,
  MENSAJE_COBERTURA_APROBADA_INTRO,
  MENSAJE_COBERTURA_RECHAZADA_DEFAULT,
  MENSAJE_CARRITO_VACIO_APROBADO,
  MENSAJE_COBERTURA_VENCIDA,
} from './coverageResume.js';
import { ProductNoVendibleError, ProductoConDerivaCriticaError } from '../orders/createPendingOrder.js';
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

/**
 * ADR-0015 §8 — la deriva es SUBCLASE de ProductNoVendibleError (mismo freno, misma retención del
 * job). Chequear solo la clase base hacía que la campana dijera "producto no disponible" cuando el
 * producto está en stock y lo que no coincide es el PRECIO publicado: el vendedor salía a buscar
 * inventario que nunca faltó. La razón avisada tiene que ser la real.
 */
describe('coverageResume — razón honesta cuando el pedido aprobado no se puede crear', () => {
  const DERIVA = new ProductoConDerivaCriticaError({
    bloqueantes: [{ productId: 'p1', productName: 'Producto Uno', reason: 'drifted_external', fields: ['price'] }],
    advertencias: [],
  });

  it('deriva del dato público ⇒ motivo catalog_drift, mensaje de PRECIO y dedupeKey propio', () => {
    const a = avisoReanudacionBloqueada(DERIVA, '595000005678', 'covr_1');
    expect(a.motivo).toBe('catalog_drift');
    expect(a.notifId).toBe('covdrift-595000005678-covr_1');
    expect(a.title).toMatch(/precio/i);
    expect(a.body).toMatch(/precio o la disponibilidad publicada/i);
    expect(a.body).not.toMatch(/ya no está disponible|no están disponibles/i); // razón equivocada
  });

  it('producto realmente no vendible ⇒ motivo no_vendible y el mensaje de stock de siempre', () => {
    const a = avisoReanudacionBloqueada(new ProductNoVendibleError(['Producto Uno']), '595000005678', 'covr_1');
    expect(a.motivo).toBe('no_vendible');
    expect(a.notifId).toBe('covstock-595000005678-covr_1');
    expect(a.body).toMatch(/ya no está disponible/i);
  });

  it('el aviso es SANEADO: teléfono enmascarado y ni un precio (local o publicado)', () => {
    for (const e of [DERIVA, new ProductNoVendibleError(['Producto Uno', 'Producto Dos'])]) {
      const a = avisoReanudacionBloqueada(e, '595000005678', 'covr_1');
      expect(`${a.title} ${a.body}`).not.toContain('595000005678');
      expect(`${a.title} ${a.body}`).toContain('…5678');
      // Ningún importe: los 4 dígitos que quedan son los del teléfono enmascarado, nada más.
      expect(`${a.title} ${a.body}`).not.toMatch(/\d{5,}/);
    }
  });
});

describe('SHIPPING-CHAT-3C — orderCartInputFromSnapshot (adapter validado snapshot→orden)', () => {
  it('snapshot íntegro ⇒ OrderCartInput sin casts ni imageUrl inventada', async () => {
    const { orderCartInputFromSnapshot } = await import('./coverageResume.js');
    const out = orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: 'Perfume', price: 100000, quantity: 2 }], subtotal: 200000 });
    expect(out).toEqual({ items: [{ productId: 'p1', name: 'Perfume', price: 100000, quantity: 2 }], subtotal: 200000 });
  });
  it('fail-closed: null/vacío/subtotal≠Σ/no-enteros/negativos/overflow ⇒ null (jamás una orden con dinero inválido)', async () => {
    const { orderCartInputFromSnapshot } = await import('./coverageResume.js');
    expect(orderCartInputFromSnapshot(null)).toBeNull();
    expect(orderCartInputFromSnapshot(undefined)).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [], subtotal: 0 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: 'X', price: 100, quantity: 1 }], subtotal: 999 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: 'X', price: 100.5, quantity: 1 }], subtotal: 100.5 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: 'X', price: -1, quantity: 1 }], subtotal: -1 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: 'X', price: 100, quantity: 0 }], subtotal: 0 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: '', name: 'X', price: 100, quantity: 1 }], subtotal: 100 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: '', price: 100, quantity: 1 }], subtotal: 100 })).toBeNull();
    expect(orderCartInputFromSnapshot({ items: [{ productId: 'p1', name: 'X', price: Number.MAX_SAFE_INTEGER, quantity: 2 }], subtotal: 0 })).toBeNull();
  });
});
