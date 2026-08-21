/**
 * checkoutConfig.test.ts — H-04: un dato de cobro FALSO jamás sale hacia un cliente.
 *
 * Defecto auditado (`docs/system-audit-2026-08.md` §H-04): `getCheckoutConfig` caía a un
 * `DEFAULT_CONFIG` con placeholders literales por DOS caminos —documento ausente y array
 * vacío— y `formatTransferInstructions` los imprimía tal cual en el mensaje de WhatsApp. El
 * cliente recibía, textual:
 *
 *     🏦 *UENO Bank*
 *        Cuenta: REEMPLAZAR-Nro-Cuenta
 *
 * Se llega ahí por dos vías reales: un tenant nuevo (nace con `botEnabled: true` y sin
 * `config/checkout`) y un dueño que borra todas sus cuentas desde el panel.
 *
 * El equipo YA cerró esta misma clase de bug del lado de los vendedores
 * (`conversation/humanRequest.ts:200`, y también en aiUnavailable/driftHandoff/coverage): los
 * placeholders no cuentan como configuración. Acá se cierra el camino del dinero con el mismo
 * criterio.
 *
 * Nota sobre los datos: todo lo que se usa acá es inventado y evidentemente de prueba.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('../lib/firebase.js', () => ({
  db: () => ({ doc: () => ({ get: getMock }) }),
}));

import { getCheckoutConfig, pickSeller, formatTransferInstructions, cuentasCobrables } from './checkoutConfig.js';
import type { BankAccount, CheckoutConfig } from '@vpw/shared';

/** Cuenta de prueba, sin ningún parecido con una real. */
const CUENTA_OK: BankAccount = {
  bank: 'Banco de Prueba',
  accountNumber: '00-TEST-0001',
  holder: 'Titular Ficticio SA',
  document: 'TEST-123456',
};
const CUENTA_PLACEHOLDER: BankAccount = {
  bank: 'UENO Bank',
  accountNumber: 'REEMPLAZAR-Nro-Cuenta',
  holder: 'REEMPLAZAR-Titular',
  document: 'REEMPLAZAR-CI/RUC',
};

const snap = (data: unknown) => ({ exists: data !== null, data: () => data });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('H-04 · getCheckoutConfig no inventa datos de cobro', () => {
  it('sin documento de checkout devuelve VACÍO, no placeholders', async () => {
    getMock.mockResolvedValue(snap(null));

    const cfg = await getCheckoutConfig('tenant-nuevo');

    expect(cfg.bankAccounts).toEqual([]);
    expect(cfg.sellers).toEqual([]);
    expect(JSON.stringify(cfg)).not.toMatch(/REEMPLAZAR/i);
  });

  it('con arrays vacíos NO los reemplaza por los del default', async () => {
    getMock.mockResolvedValue(snap({ bankAccounts: [], sellers: [] }));

    const cfg = await getCheckoutConfig('tenant-sin-cuentas');

    expect(cfg.bankAccounts).toEqual([]);
    expect(cfg.sellers).toEqual([]);
  });

  it('NO REGRESIÓN: con datos reales devuelve exactamente lo guardado', async () => {
    const guardado: CheckoutConfig = {
      bankAccounts: [CUENTA_OK],
      sellers: [{ name: 'Vendedora Ficticia', whatsapp: '+595000000001', active: true }],
    };
    getMock.mockResolvedValue(snap(guardado));

    const cfg = await getCheckoutConfig('tenant-configurado');

    expect(cfg.bankAccounts).toEqual([CUENTA_OK]);
    expect(cfg.sellers).toEqual(guardado.sellers);
  });

  it('NO REGRESIÓN: `coverage` sigue viajando crudo cuando existe', async () => {
    getMock.mockResolvedValue(snap({ bankAccounts: [CUENTA_OK], sellers: [], coverage: { enabled: true, activationId: 'act-1' } }));

    const cfg = await getCheckoutConfig('tenant-coverage');

    expect((cfg as { coverage?: unknown }).coverage).toEqual({ enabled: true, activationId: 'act-1' });
  });
});

describe('H-04 · las cuentas con placeholder no son cobrables', () => {
  it('filtra la cuenta con marcador en cualquiera de sus campos', () => {
    const mezcla = [CUENTA_OK, CUENTA_PLACEHOLDER, { ...CUENTA_OK, holder: 'REEMPLAZAR-Titular' }];

    expect(cuentasCobrables({ bankAccounts: mezcla, sellers: [] })).toEqual([CUENTA_OK]);
  });

  it('no se evade con mayúsculas, minúsculas ni espacios alrededor', () => {
    const evasivas: BankAccount[] = [
      { ...CUENTA_OK, accountNumber: 'reemplazar-nro-cuenta' },
      { ...CUENTA_OK, holder: '  REEMPLAZAR  ' },
      { ...CUENTA_OK, document: 'Reemplazar-CI/RUC' },
    ];

    expect(cuentasCobrables({ bankAccounts: evasivas, sellers: [] })).toEqual([]);
  });

  it('el ALIAS no puede invalidar una cuenta: es opcional', () => {
    // La primera versión de este fix filtraba también por alias, y `config/validate.ts` persiste
    // '' cuando el dueño lo deja vacío ⇒ un tenant con TODOS sus datos buenos dejaba de cobrar
    // (review). Un alias vacío, nulo o de plantilla no toca la validez de la cuenta.
    const conAlias: BankAccount[] = [
      { ...CUENTA_OK, alias: '' },
      { ...CUENTA_OK, alias: undefined },
      { ...CUENTA_OK, alias: 'REEMPLAZAR-alias' },
    ];

    expect(cuentasCobrables({ bankAccounts: conAlias, sellers: [] })).toHaveLength(3);
    // Pero un alias de plantilla NO se imprime en el mensaje del cliente.
    const texto = formatTransferInstructions({ bankAccounts: [{ ...CUENTA_OK, alias: 'REEMPLAZAR-alias' }], sellers: [] }, 280000);
    expect(texto).not.toMatch(/REEMPLAZAR/i);
    expect(texto).not.toMatch(/Alias:/);
  });

  it('un campo NUMÉRICO en Firestore no tira el turno del cliente', () => {
    // El tipo dice string, pero Firestore devuelve lo que se haya guardado. Un `.trim()` sobre un
    // número lanzaba TypeError adentro del motor y el cliente no recibía nada (review).
    const numerico = [{ ...CUENTA_OK, document: 4567890 as unknown as string }];

    expect(() => cuentasCobrables({ bankAccounts: numerico, sellers: [] })).not.toThrow();
    expect(cuentasCobrables({ bankAccounts: numerico, sellers: [] })).toHaveLength(1);
  });

  it('un campo con OTRA FORMA (no array) no rompe: se trata como vacío', () => {
    const roto = { bankAccounts: 'esto no es un array', sellers: null } as unknown as CheckoutConfig;

    expect(() => cuentasCobrables(roto)).not.toThrow();
    expect(cuentasCobrables(roto)).toEqual([]);
    expect(pickSeller(roto)).toBeNull();
  });

  it('una cuenta a medio cargar (campo vacío) tampoco es cobrable', () => {
    const incompletas: BankAccount[] = [
      { ...CUENTA_OK, accountNumber: '' },
      { ...CUENTA_OK, holder: '   ' },
    ];

    expect(cuentasCobrables({ bankAccounts: incompletas, sellers: [] })).toEqual([]);
  });

  it('NO REGRESIÓN: una cuenta real cuyo titular MENCIONA la palabra sigue siendo válida', () => {
    // Fail-closed sí, pero no paranoico: el marcador es el prefijo del seed, no la palabra suelta.
    const real: BankAccount = { ...CUENTA_OK, holder: 'Reemplazos Industriales SA' };

    expect(cuentasCobrables({ bankAccounts: [real], sellers: [] })).toEqual([real]);
  });


});

describe('H-04 · formatTransferInstructions', () => {
  it('sin cuentas cobrables devuelve null: el bot no puede instruir un pago', () => {
    expect(formatTransferInstructions({ bankAccounts: [], sellers: [] }, 280000)).toBeNull();
    expect(formatTransferInstructions({ bankAccounts: [CUENTA_PLACEHOLDER], sellers: [] }, 280000)).toBeNull();
  });

  it('con mezcla, el mensaje lleva SOLO las cuentas reales', () => {
    const texto = formatTransferInstructions({ bankAccounts: [CUENTA_OK, CUENTA_PLACEHOLDER], sellers: [] }, 280000);

    expect(texto).not.toBeNull();
    expect(texto).not.toMatch(/REEMPLAZAR/i);
    expect(texto).toContain('Banco de Prueba');
    expect(texto).not.toContain('UENO Bank');
  });

  it('NO REGRESIÓN: con cuentas reales el mensaje sale idéntico a como salía', () => {
    // El formato es contrato con el cliente: mismos emojis, mismo orden, mismo cierre.
    const texto = formatTransferInstructions(
      { bankAccounts: [{ ...CUENTA_OK, alias: 'alias.ficticio' }], sellers: [] },
      280000,
    );

    expect(texto).toBe(
      '💳 *Para completar tu compra*\nTotal a transferir: *₲ 280.000*\n\n' +
        'Transferí a cualquiera de estas cuentas:\n\n' +
        '🏦 *Banco de Prueba*\n   Cuenta: 00-TEST-0001\n   Titular: Titular Ficticio SA\n   CI/RUC: TEST-123456\n   Alias: alias.ficticio' +
        '\n\n📸 Cuando transfieras, *mandame la foto del comprobante* y un vendedor confirma tu pedido enseguida 🙌',
    );
  });
});

describe('H-04 · pickSeller no devuelve un vendedor de plantilla', () => {
  it('el placeholder del seed no cuenta como vendedor', () => {
    const cfg: CheckoutConfig = {
      bankAccounts: [],
      sellers: [{ name: 'REEMPLAZAR-Vendedor', whatsapp: '+595000000000', active: true }],
    };

    expect(pickSeller(cfg)).toBeNull();
  });

  it('NO REGRESIÓN: elige el primer vendedor activo real', () => {
    const real = { name: 'Vendedora Ficticia', whatsapp: '+595000000001', active: true };
    const cfg: CheckoutConfig = {
      bankAccounts: [],
      sellers: [
        { name: 'REEMPLAZAR-Vendedor', whatsapp: '+595000000000', active: true },
        { name: 'Inactivo Ficticio', whatsapp: '+595000000002', active: false },
        real,
      ],
    };

    expect(pickSeller(cfg)).toEqual(real);
  });
});
