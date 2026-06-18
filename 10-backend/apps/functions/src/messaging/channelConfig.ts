/**
 * messaging/channelConfig.ts — Config por canal del tenant (Fase 4A)
 * =================================================================
 * Vive en tenants/{tenantId}/config/channels. Default whatsappSendMode='mock':
 * el envío REAL a WhatsApp solo ocurre si el Owner lo pone en 'live'. Separa el
 * "responder en WhatsApp real" del on/off del agente (AgentConfig.botEnabled).
 */

import type { ChannelConfig } from '@vpw/shared';
import { db } from '../lib/firebase.js';

const DEFAULT: ChannelConfig = { whatsappSendMode: 'mock' };

export async function getChannelConfig(tenantId: string): Promise<ChannelConfig> {
  const snap = await db().doc(`tenants/${tenantId}/config/channels`).get();
  if (!snap.exists) return DEFAULT;
  return { ...DEFAULT, ...(snap.data() as Partial<ChannelConfig>) };
}
