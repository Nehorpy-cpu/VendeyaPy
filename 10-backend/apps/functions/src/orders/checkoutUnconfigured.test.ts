/**
 * checkoutUnconfigured.test.ts — H-04 §5.5: el dueño se entera, sin avalancha.
 *
 * Que el bot deje de mandar cuentas falsas es media solución. La otra mitad es que alguien se
 * entere: un tenant con clientes intentando pagar y sin datos de cobro está perdiendo ventas en
 * silencio, que es el defecto que más caro salió en este proyecto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: (ruta: string) => ({ create: (d: unknown) => createMock(ruta, d) }) }),
  paths: { notifications: (t: string) => `tenants/${t}/notifications` },
}));

import { avisarCheckoutSinDatos, idAvisoSinDatosDeCobro, MENSAJE_SIN_DATOS_DE_COBRO } from './checkoutUnconfigured.js';

/** 2026-08-21T15:00:00Z — fecha fija: el id lleva el día y no puede depender del reloj real. */
const DIA_1 = Date.UTC(2026, 7, 21, 15, 0, 0);
const DIA_1_MAS_TARDE = Date.UTC(2026, 7, 21, 23, 30, 0);
const DIA_2 = Date.UTC(2026, 7, 22, 0, 30, 0);

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue(undefined);
});

describe('H-04 · aviso al dueño', () => {
  it('crea el aviso en la campana del tenant', async () => {
    const creado = await avisarCheckoutSinDatos('tenant-nuevo', '595990000001', DIA_1);

    expect(creado).toBe(true);
    const [ruta, doc] = createMock.mock.calls[0]!;
    expect(ruta).toBe(`tenants/tenant-nuevo/notifications/${idAvisoSinDatosDeCobro('tenant-nuevo', DIA_1)}`);
    expect(doc).toMatchObject({
      category: 'handoff',
      type: 'handoff_checkout_unconfigured',
      read: false,
    });
    expect(doc.body).toMatch(/cuenta bancaria/i);
  });

  it('el CUERPO no lleva PII, pero el aviso identifica al cliente que quedó esperando', async () => {
    await avisarCheckoutSinDatos('tenant-nuevo', '595990000001', DIA_1);

    const [, doc] = createMock.mock.calls[0]!;
    // El texto no lleva teléfono ni contenido del mensaje (el timestamp de creación también es un
    // número largo, por eso se miran solo los campos de TEXTO).
    expect(`${doc.title} ${doc.body}`).not.toMatch(/\d{4,}/);
    // Pero el `customerId` sí viaja, como en el resto de los avisos de handoff: sin eso el dueño
    // lee «un cliente quiso pagar» y no tiene forma de saber a quién atender (review).
    expect(doc.customerId).toBe('595990000001');
  });

  it('es idempotente: mismo día ⇒ mismo id ⇒ un solo aviso', async () => {
    // El id es la clave de idempotencia; Firestore rechaza el segundo `create()`.
    expect(idAvisoSinDatosDeCobro('t1', DIA_1)).toBe(idAvisoSinDatosDeCobro('t1', DIA_1_MAS_TARDE));

    createMock.mockRejectedValueOnce(Object.assign(new Error('ya existe'), { code: 6 }));
    expect(await avisarCheckoutSinDatos('t1', '595990000002', DIA_1_MAS_TARDE)).toBe(false);
  });

  it('al día siguiente vuelve a avisar: el problema sigue vivo', async () => {
    expect(idAvisoSinDatosDeCobro('t1', DIA_1)).not.toBe(idAvisoSinDatosDeCobro('t1', DIA_2));
  });

  it('cada tenant tiene su propio aviso', () => {
    expect(idAvisoSinDatosDeCobro('t1', DIA_1)).not.toBe(idAvisoSinDatosDeCobro('t2', DIA_1));
  });

  it('un fallo del aviso no se propaga: nunca rompe la venta', async () => {
    createMock.mockRejectedValue(new Error('firestore caído'));

    await expect(avisarCheckoutSinDatos('t1', '595990000001', DIA_1)).resolves.toBe(false);
  });
});

describe('H-04 · el mensaje al cliente', () => {
  it('no promete datos que no existen ni deja al cliente sin respuesta', () => {
    expect(MENSAJE_SIN_DATOS_DE_COBRO.trim().length).toBeGreaterThan(0);
    expect(MENSAJE_SIN_DATOS_DE_COBRO).not.toMatch(/REEMPLAZAR/i);
    expect(MENSAJE_SIN_DATOS_DE_COBRO).not.toMatch(/transferí a/i);
    // Dice que el pedido quedó anotado: el cliente no cree que se perdió.
    expect(MENSAJE_SIN_DATOS_DE_COBRO).toMatch(/pedido anotado/i);
    // Y NO promete que alguien va a escribirle: no hay handoff detrás que lo respalde, y el propio
    // sistema se prohíbe esa promesa (`ai/prompts.ts`).
    expect(MENSAJE_SIN_DATOS_DE_COBRO).not.toMatch(/te (va a )?(escrib|contact)/i);
  });
});
