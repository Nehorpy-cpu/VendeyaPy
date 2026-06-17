/**
 * Integración con Meta (Track D / D1). La conexión guarda solo una REFERENCIA al
 * token (en Secret Manager) — nunca el token en claro (ADR-0009). Los assets son
 * las cuentas/activos de Meta vinculados (WhatsApp, IG, página, ad account, etc.).
 * Subcolecciones: tenants/{t}/metaConnections/{id} · tenants/{t}/metaAssets/{id}.
 */

import type { MetaConnectionStatus, MetaAssetType } from '../enums.js';
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
