/**
 * Capa de acceso a la configuración del agente y de checkout (panel).
 * Docs Firestore: tenants/{t}/config/agent  y  tenants/{t}/config/checkout.
 *
 * LECTURAS: directas a Firestore (las reglas permiten leer a Owner/Viewer).
 * ESCRITURAS: pasan por callables seguros del backend (Fase 5C), NO por write directo:
 *   - agentConfigUpdate    (config/agent: whitelist de campos del agente)
 *   - checkoutConfigUpdate  (config/checkout: bankAccounts/sellers)
 * El tenant sale del token; solo PLATFORM_ADMIN operando otra empresa usa `tenantId`.
 */

import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { AgentConfig, CheckoutConfig } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

export const DEFAULT_AGENT: AgentConfig = {
  agentName: 'Sofía',
  businessName: 'Perfumería AFG',
  tone: 'amable y cercano',
  language: 'es',
  greetingMessage: '',
  farewellMessage: '',
  fallbackMessage: '',
  handoffMessage: '',
  salesRules: '',
  faq: [],
  botEnabled: true,
  testMode: false,
  profitMode: false,
  industry: '',
};

const agentRef = (t: string) => doc(firebaseDb(), 'tenants', t, 'config', 'agent');
const checkoutRef = (t: string) => doc(firebaseDb(), 'tenants', t, 'config', 'checkout');

export async function getAgentConfig(tenantId: string): Promise<AgentConfig> {
  const snap = await getDoc(agentRef(tenantId));
  return snap.exists() ? { ...DEFAULT_AGENT, ...(snap.data() as Partial<AgentConfig>) } : DEFAULT_AGENT;
}

export async function saveAgentConfig(tenantId: string, cfg: AgentConfig): Promise<void> {
  // Vía callable `agentConfigUpdate` (whitelist + audit, set merge server-side). NO write directo.
  const call = httpsCallable<{ tenantId: string; data: unknown }, { ok: boolean }>(firebaseFunctions(), 'agentConfigUpdate');
  await call({ tenantId, data: cfg });
}

export async function getCheckoutConfig(tenantId: string): Promise<CheckoutConfig> {
  const snap = await getDoc(checkoutRef(tenantId));
  const base: CheckoutConfig = { bankAccounts: [], sellers: [] };
  return snap.exists() ? { ...base, ...(snap.data() as Partial<CheckoutConfig>) } : base;
}

export async function saveCheckoutConfig(tenantId: string, cfg: CheckoutConfig): Promise<void> {
  // Vía callable `checkoutConfigUpdate` (valida bankAccounts/sellers, set merge server-side). NO write directo.
  const call = httpsCallable<{ tenantId: string; data: unknown }, { ok: boolean }>(firebaseFunctions(), 'checkoutConfigUpdate');
  await call({ tenantId, data: cfg });
}
