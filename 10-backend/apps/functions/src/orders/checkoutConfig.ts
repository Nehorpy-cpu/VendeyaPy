/**
 * orders/checkoutConfig.ts — Config de cobro por transferencia (F6b)
 * ==================================================================
 * Cuentas bancarias a las que el cliente transfiere + vendedores a los que
 * se deriva la venta. Se guarda en Firestore en `tenants/{t}/config/checkout`.
 *
 * Si el doc no existe, se usa un DEFAULT con PLACEHOLDERS (marcados "REEMPLAZAR").
 * El owner reemplaza por sus datos reales (ver scripts/seed-checkout-config.mjs
 * o cargándolo en Firestore). Los números de cuenta son datos para compartir con
 * clientes (no secretos), pero igual no se versionan con datos reales en el repo.
 */

import { db } from '../lib/firebase.js';

import type { BankAccount, Seller, CheckoutConfig } from '@vpw/shared';
export type { BankAccount, Seller, CheckoutConfig };

/** Default con placeholders — REEMPLAZAR por datos reales del negocio. */
const DEFAULT_CONFIG: CheckoutConfig = {
  bankAccounts: [
    {
      bank: 'UENO Bank',
      accountNumber: 'REEMPLAZAR-Nro-Cuenta',
      holder: 'REEMPLAZAR-Titular',
      document: 'REEMPLAZAR-CI/RUC',
    },
    {
      bank: 'Banco Familiar',
      accountNumber: 'REEMPLAZAR-Nro-Cuenta',
      holder: 'REEMPLAZAR-Titular',
      document: 'REEMPLAZAR-CI/RUC',
    },
  ],
  sellers: [
    { name: 'REEMPLAZAR-Vendedor', whatsapp: '+595000000000', active: true },
  ],
};

export async function getCheckoutConfig(tenantId: string): Promise<CheckoutConfig> {
  const snap = await db().doc(`tenants/${tenantId}/config/checkout`).get();
  if (!snap.exists) return DEFAULT_CONFIG;
  const data = snap.data() as Partial<CheckoutConfig>;
  return {
    bankAccounts: data.bankAccounts?.length ? data.bankAccounts : DEFAULT_CONFIG.bankAccounts,
    sellers: data.sellers?.length ? data.sellers : DEFAULT_CONFIG.sellers,
    // COVERAGE-1B: crudo tal cual — lo valida coverageSettings() (ausente/inválido ⇒ off).
    ...(data.coverage !== undefined ? { coverage: data.coverage } : {}),
  };
}

/** Elige el vendedor activo a asignar. Hoy: el primero activo (varios → rotación en el futuro). */
export function pickSeller(config: CheckoutConfig): Seller | null {
  return config.sellers.find((s) => s.active) ?? null;
}

/** Arma el texto de instrucciones de transferencia para el cliente. */
export function formatTransferInstructions(config: CheckoutConfig, totalGs: number): string {
  const monto = '₲ ' + totalGs.toLocaleString('es-PY');
  let out = `💳 *Para completar tu compra*\nTotal a transferir: *${monto}*\n\nTransferí a cualquiera de estas cuentas:`;
  for (const a of config.bankAccounts) {
    out += `\n\n🏦 *${a.bank}*\n   Cuenta: ${a.accountNumber}\n   Titular: ${a.holder}\n   CI/RUC: ${a.document}`;
    if (a.alias) out += `\n   Alias: ${a.alias}`;
  }
  out += '\n\n📸 Cuando transfieras, *mandame la foto del comprobante* y un vendedor confirma tu pedido enseguida 🙌';
  return out;
}
