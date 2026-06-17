/**
 * Biblioteca de respuestas ganadoras (P18). Respuestas que aparecieron en chats
 * que cerraron venta (source 'auto', con conteo de conversiones) o curadas a mano
 * (source 'manual'). El staff las copia y reutiliza.
 * Subcolección: tenants/{t}/winningReplies/{replyId}.
 */

import type { ReplyStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface WinningReply {
  id: string;
  tenantId: string;
  text: string;
  category: string;
  source: 'auto' | 'manual';
  /** En cuántos chats que cerraron venta apareció (solo 'auto'). */
  conversions: number;
  status: ReplyStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
