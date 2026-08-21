/**
 * orders/checkoutConfig.ts — Config de cobro por transferencia (F6b)
 * ==================================================================
 * Cuentas bancarias a las que el cliente transfiere + vendedores a los que
 * se deriva la venta. Se guarda en Firestore en `tenants/{t}/config/checkout`.
 *
 * H-04 (auditoría 2026-08-19): este módulo tenía un `DEFAULT_CONFIG` con placeholders
 * (`REEMPLAZAR-Nro-Cuenta`) al que se caía por DOS caminos —documento ausente y array vacío— y
 * `formatTransferInstructions` los imprimía tal cual en el mensaje de WhatsApp. El cliente
 * recibía datos bancarios inventados. Se llegaba ahí de dos formas reales: un tenant nuevo
 * (nace con `botEnabled: true` y sin `config/checkout`) y un dueño que borra sus cuentas
 * desde el panel.
 *
 * El default se eliminó: **vacío significa vacío**, nunca «acá están estas cuentas». Un tenant
 * sin datos de cobro no es un error del sistema — es un tenant que todavía no puede cobrar por
 * el bot, y ese caso se resuelve derivando a una persona (lo hacen los llamadores), no
 * inventando una cuenta.
 *
 * El criterio de «esto es de plantilla, no cuenta» ya existía para los VENDEDORES
 * (`conversation/humanRequest.ts`, `aiUnavailable.ts`, `driftHandoff.ts`, `coverage.ts`);
 * acá se aplica el mismo al dinero.
 */

import { db } from '../lib/firebase.js';

import type { BankAccount, Seller, CheckoutConfig } from '@vpw/shared';
export type { BankAccount, Seller, CheckoutConfig };

/**
 * Marcador de los datos de plantilla del seed. Se ancla al principio del valor (ya recortado):
 * el prefijo `REEMPLAZAR-…` es de plantilla, pero un titular real que se llame «Reemplazos
 * Industriales SA» sigue siendo válido.
 */
const MARCADOR_PLANTILLA = /^REEMPLAZAR/i;

/**
 * Un campo cuenta como real si tiene contenido y no es el marcador del seed.
 * `String(...)`: Firestore puede devolver un número donde el tipo dice string (un CI/RUC cargado
 * a mano, por ejemplo). Antes eso se imprimía sin drama; un `.trim()` sobre un número tiraba el
 * turno entero del cliente (review).
 */
function esValorReal(v: unknown): boolean {
  const s = String(v ?? '').trim();
  return s.length > 0 && !MARCADOR_PLANTILLA.test(s);
}

/**
 * Las cuentas a las que un cliente PUEDE transferir de verdad: los cuatro datos que se le
 * mandan tienen que ser reales. Fail-closed sobre el dinero — ante la duda, no es cobrable.
 */
export function cuentasCobrables(config: CheckoutConfig): BankAccount[] {
  const cuentas = Array.isArray(config.bankAccounts) ? config.bankAccounts : [];
  // El `alias` NO entra en el filtro: es OPCIONAL, y filtrarlo tumbaba la cuenta ENTERA por un campo
  // que ni siquiera se exige — un '' o un null guardado en Firestore dejaba sin cobrar a un tenant
  // con todos sus datos buenos (review). Lo que sí se evita es imprimir un alias de plantilla.
  return cuentas.filter(
    (a) =>
      esValorReal(a?.bank) &&
      esValorReal(a?.accountNumber) &&
      esValorReal(a?.holder) &&
      esValorReal(a?.document),
  );
}

export async function getCheckoutConfig(tenantId: string): Promise<CheckoutConfig> {
  const snap = await db().doc(`tenants/${tenantId}/config/checkout`).get();
  // H-04: sin documento NO hay datos de cobro. Antes se devolvían los placeholders del seed, que
  // terminaban impresos en el WhatsApp del cliente.
  if (!snap.exists) return { bankAccounts: [], sellers: [] };
  const data = snap.data() as Partial<CheckoutConfig>;
  return {
    // H-04: un array vacío se respeta como vacío. El fallback que había acá era el segundo
    // camino a los datos falsos (el dueño borra sus cuentas desde el panel y guarda).
    // `Array.isArray`: un campo con otra forma en Firestore reventaría en el `.filter` de abajo.
    bankAccounts: Array.isArray(data.bankAccounts) ? data.bankAccounts : [],
    sellers: Array.isArray(data.sellers) ? data.sellers : [],
    // COVERAGE-1B: crudo tal cual — lo valida coverageSettings() (ausente/inválido ⇒ off).
    ...(data.coverage !== undefined ? { coverage: data.coverage } : {}),
  };
}

/**
 * Elige el vendedor activo a asignar. Hoy: el primero activo (varios → rotación en el futuro).
 * H-04: un vendedor de plantilla no es un vendedor — sin esto, `submitComprobante` asignaba el
 * pedido a «REEMPLAZAR-Vendedor». Mismo criterio que ya aplicaban los flujos de derivación.
 */
export function pickSeller(config: CheckoutConfig): Seller | null {
  const vendedores = Array.isArray(config.sellers) ? config.sellers : [];
  return vendedores.find((s) => s?.active && esValorReal(s.name)) ?? null;
}

/**
 * Arma el texto de instrucciones de transferencia para el cliente.
 * Devuelve `null` cuando el tenant no tiene ninguna cuenta cobrable: el bot NO instruye un pago
 * que no puede recibir, y el llamador deriva a una persona en vez de mandar cuentas inventadas.
 */
export function formatTransferInstructions(config: CheckoutConfig, totalGs: number): string | null {
  const cuentas = cuentasCobrables(config);
  if (cuentas.length === 0) return null;
  const monto = '₲ ' + totalGs.toLocaleString('es-PY');
  let out = `💳 *Para completar tu compra*\nTotal a transferir: *${monto}*\n\nTransferí a cualquiera de estas cuentas:`;
  for (const a of cuentas) {
    out += `\n\n🏦 *${a.bank}*\n   Cuenta: ${a.accountNumber}\n   Titular: ${a.holder}\n   CI/RUC: ${a.document}`;
    // Un alias de plantilla no se imprime, pero tampoco invalida la cuenta.
    if (a.alias && esValorReal(a.alias)) out += `\n   Alias: ${a.alias}`;
  }
  out += '\n\n📸 Cuando transfieras, *mandame la foto del comprobante* y un vendedor confirma tu pedido enseguida 🙌';
  return out;
}
