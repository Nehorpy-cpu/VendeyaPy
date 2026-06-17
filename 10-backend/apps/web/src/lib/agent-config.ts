/**
 * Capa de acceso a la configuración del agente y de checkout (panel).
 * Docs Firestore: tenants/{t}/config/agent  y  tenants/{t}/config/checkout.
 */

import { doc, getDoc, setDoc } from 'firebase/firestore';
import type { AgentConfig, CheckoutConfig } from '@vpw/shared';
import { firebaseDb } from './firebase';

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
};

const agentRef = (t: string) => doc(firebaseDb(), 'tenants', t, 'config', 'agent');
const checkoutRef = (t: string) => doc(firebaseDb(), 'tenants', t, 'config', 'checkout');

export async function getAgentConfig(tenantId: string): Promise<AgentConfig> {
  const snap = await getDoc(agentRef(tenantId));
  return snap.exists() ? { ...DEFAULT_AGENT, ...(snap.data() as Partial<AgentConfig>) } : DEFAULT_AGENT;
}

export async function saveAgentConfig(tenantId: string, cfg: AgentConfig): Promise<void> {
  await setDoc(agentRef(tenantId), cfg, { merge: true });
}

export async function getCheckoutConfig(tenantId: string): Promise<CheckoutConfig> {
  const snap = await getDoc(checkoutRef(tenantId));
  const base: CheckoutConfig = { bankAccounts: [], sellers: [] };
  return snap.exists() ? { ...base, ...(snap.data() as Partial<CheckoutConfig>) } : base;
}

export async function saveCheckoutConfig(tenantId: string, cfg: CheckoutConfig): Promise<void> {
  await setDoc(checkoutRef(tenantId), cfg, { merge: true });
}
