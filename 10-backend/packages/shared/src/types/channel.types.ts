/**
 * Configuración por canal del tenant (Fase 4A).
 * Vive en Firestore: tenants/{tenantId}/config/channels. Editable por el Owner.
 * Controla si el bot responde en WhatsApp REAL (separado del on/off del agente).
 */

import type { WhatsappSendMode } from '../enums.js';

export interface ChannelConfig {
  /**
   * 'mock' (default) = NO se envía a Meta (solo se simula/loguea).
   * 'live' = envío real por la conexión Meta del tenant (si está conectada y con token).
   */
  whatsappSendMode: WhatsappSendMode;
}
