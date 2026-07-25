/**
 * meta/catalogSyncConfig.ts — Config por tenant de la sync de catálogo (META-CATALOG-LIVE-1)
 * ==========================================================================================
 * Vive en `tenants/{t}/config/meta` campo `catalogSync`. FAIL-CLOSED: cualquier forma
 * inválida, ausente o parcial se normaliza a { enabled:false, mode:'off' } — un tenant sin
 * config explícita (p.ej. credipower) JAMÁS sincroniza. La fuente de verdad es SIEMPRE
 * VendeyaPy→Meta (`sourceOfTruth:'vendeyapy'`); cualquier otro valor desactiva la sync.
 */

export const CATALOG_SYNC_MODES = ['off', 'dry_run', 'live'] as const;
export type CatalogSyncMode = (typeof CATALOG_SYNC_MODES)[number];

export interface MetaCatalogSyncConfig {
  enabled: boolean;
  mode: CatalogSyncMode;
  /** ID del catálogo en Meta Commerce Manager. Sin valor válido ⇒ sync apagada. */
  catalogId: string;
  sourceOfTruth: 'vendeyapy';
}

export const CATALOG_SYNC_DISABLED: MetaCatalogSyncConfig = Object.freeze({
  enabled: false,
  mode: 'off',
  catalogId: '',
  sourceOfTruth: 'vendeyapy',
});

// El catalogId viaja en la URL del Graph API: solo caracteres seguros, sin '/' ni espacios.
const VALID_CATALOG_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Normaliza el campo `catalogSync` del doc de config. Cualquier duda ⇒ apagado. */
export function normalizeCatalogSyncConfig(raw: unknown): MetaCatalogSyncConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return CATALOG_SYNC_DISABLED;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return CATALOG_SYNC_DISABLED;
  if (r.mode !== 'dry_run' && r.mode !== 'live') return CATALOG_SYNC_DISABLED;
  if (r.sourceOfTruth !== 'vendeyapy') return CATALOG_SYNC_DISABLED;
  const catalogId = typeof r.catalogId === 'string' ? r.catalogId.trim() : '';
  if (!VALID_CATALOG_ID.test(catalogId)) return CATALOG_SYNC_DISABLED;
  return { enabled: true, mode: r.mode, catalogId, sourceOfTruth: 'vendeyapy' };
}
