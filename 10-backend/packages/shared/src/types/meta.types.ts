/**
 * Integración con Meta (Track D / D1). La conexión guarda solo una REFERENCIA al
 * token (en Secret Manager) — nunca el token en claro (ADR-0009). Los assets son
 * las cuentas/activos de Meta vinculados (WhatsApp, IG, página, ad account, etc.).
 * Subcolecciones: tenants/{t}/metaConnections/{id} · tenants/{t}/metaAssets/{id}.
 */

import type { MetaConnectionStatus, MetaAssetType, WebhookStatus } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface MetaConnection {
  id: string;
  tenantId: string;
  metaBusinessId: string;
  metaBusinessName: string;
  connectedUserId: string;
  /** Referencia al token en Secret Manager. NUNCA el token en claro (ADR-0009). */
  tokenSecretRef: string;
  tokenType: string;
  tokenExpiresAt: Timestamp | null;
  scopes: string[];
  status: MetaConnectionStatus;
  lastVerifiedAt: Timestamp | null;
  errorMessage: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MetaAsset {
  id: string;
  tenantId: string;
  connectionId: string;
  assetType: MetaAssetType;
  externalId: string;
  name: string;
  status: string;
  selected: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Evento crudo de webhook de Meta (colección GLOBAL metaWebhookInbox). Se guarda
 * rápido, se responde a Meta, y se procesa en segundo plano (D2 · ADR-0009).
 * `expiresAt` permite TTL para limpieza automática.
 */
export interface WebhookInboxEvent {
  id: string;
  platform: string; // whatsapp | instagram | messenger
  objectType: string;
  eventType: string;
  externalId: string; // id externo del destinatario/asset (para resolver la empresa)
  tenantId: string | null;
  processingStatus: WebhookStatus;
  payload: unknown; // payload crudo
  errorMessage: string;
  receivedAt: Timestamp;
  processedAt: Timestamp | null;
  expiresAt: Timestamp | null;
}

/**
 * Índice GLOBAL para resolver a qué empresa pertenece un id externo de Meta
 * (ej: whatsapp_123…, instagram_178…). id = `${platform}_${externalId}`.
 */
export interface MetaExternalIndexEntry {
  id: string;
  tenantId: string;
  connectionId: string;
  assetType: string;
  platform: string;
  externalId: string;
  status: string;
  updatedAt: Timestamp;
}
