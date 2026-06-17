/**
 * conversation/agentConfig.ts — Lee la configuración del agente (editable en el panel)
 * ====================================================================================
 * Vive en tenants/{tenantId}/config/agent. Si no existe, usa defaults.
 * El motor usa esta config para el saludo, el on/off del bot, etc.
 */

import type { AgentConfig } from '@vpw/shared';
import { db } from '../lib/firebase.js';

const DEFAULT: AgentConfig = {
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

export async function getAgentConfig(tenantId: string): Promise<AgentConfig> {
  const snap = await db().doc(`tenants/${tenantId}/config/agent`).get();
  if (!snap.exists) return DEFAULT;
  return { ...DEFAULT, ...(snap.data() as Partial<AgentConfig>) };
}
