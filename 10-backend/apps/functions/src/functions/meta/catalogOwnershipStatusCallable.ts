/**
 * functions/meta/catalogOwnershipStatusCallable.ts — Propiedad efectiva, SOLO LECTURA
 * ====================================================================================
 * `metaCatalogOwnershipStatus` (manager+, read-only) — la tarjeta de propiedad del panel.
 *
 * Por qué existe: el panel ya llamaba a este nombre (`fetchCatalogOwnershipStatus`), pero el
 * callable NO estaba desplegado. Toda invocación fallaba, la tarjeta de propiedad quedaba en
 * error permanente y —lo grave— el bloqueo del opt-in que depende de ella quedaba FAIL-OPEN:
 * "no pude leer la propiedad" se comportaba igual que "la propiedad está sana".
 *
 * Qué devuelve: la propiedad EFECTIVA ya normalizada (fail-closed de nivel 2), la fuente
 * externa reconocida en su forma saneada, cuándo fue la última verificación de fuentes y si
 * hoy queda algún campo escribible. Nada más.
 *
 * DOS EJES QUE NO SE MEZCLAN (ADR-0015 §8), porque confundirlos fue el hallazgo:
 *  · PERMISO — «¿qué podemos ESCRIBIR nosotros?»: `enabled`, `configMode`, `effectiveMode`,
 *    `ownership.writable` y `hasWritableFields` salen de `normalizeCatalogSyncConfig`, con el
 *    gate de nivel 1 intacto. Apagar la sync sigue significando que no escribimos NADA.
 *  · REALIDAD — «¿quién gobierna el catálogo AFUERA?»: `declared`, leído sin ese gate. El feed
 *    diario del tenant no se apaga porque nosotros apaguemos nuestro interruptor, y la tarjeta
 *    que decía "todavía nadie declaró quién administra el catálogo" con un feed RECONOCIDO le
 *    mentía al owner justo sobre el hecho que motivó este ADR.
 *
 * Lo que NO hace, a propósito:
 *  · no escribe en Meta, ni en la config, ni en un producto — es una lectura;
 *  · no llama a Graph (no dispara la detección de fuentes): `detectedSources` viaja vacío y el
 *    panel usa la fuente RECONOCIDA. Detectar cuesta llamadas y es trabajo de la migración y
 *    del gate previo al POST, no de una tarjeta que el panel refresca;
 *  · no devuelve NUNCA la URL del feed, su query string, su token ni el archivo crudo: solo
 *    metadata saneada (ADR-0015 §4). `fingerprint` ya es una huella no secreta por contrato.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { CatalogExternalSourceView, CatalogOwnershipView, MetaCatalogSyncMode, WritableField } from '@vpw/shared';
import { resolvePanelAuth } from '../../panel/auth.js';
import { db } from '../../lib/firebase.js';
import { effectiveMode } from '../../meta/catalogOwnership.js';
import { externalSourceView, ownershipView } from '../../meta/catalogOwnershipMigration.js';
import { declaredExternalGovernance, normalizeCatalogSyncConfig } from '../../meta/catalogSyncConfig.js';

const REGION = 'us-central1';

/** Milisegundos de un Timestamp de Firestore, tolerante a documentos viejos. */
function aMillis(v: unknown): number | null {
  const ts = v as { toMillis?: () => number; seconds?: number } | null | undefined;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts && typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
}

/**
 * Eje REALIDAD: gobierno externo DECLARADO, saneado y sin pasar por el interruptor de sync.
 * Nunca autoriza nada — no trae `writable` ni el modo — y por eso puede reportarse honestamente
 * aunque la sincronización esté apagada.
 */
export interface CatalogDeclaredGovernanceView {
  /** Campos públicos que gobierna la fuente externa reconocida. Vacío ⇒ nadie declaró nada. */
  externalFields: WritableField[];
  /** Quién y cuándo la reconoció (metadata saneada). null ⇒ no hay declaración humana. */
  externalSource: CatalogExternalSourceView | null;
}

/** Respuesta SANEADA del callable. Es el contrato que consume el panel. */
export interface CatalogOwnershipStatusResponse {
  ok: true;
  /** Nivel 1: ¿la sincronización está configurada y habilitada para este tenant? */
  enabled: boolean;
  configMode: MetaCatalogSyncMode;
  /** Modo EFECTIVO: el techo de la propiedad nunca lo supera la config de ejecución. */
  effectiveMode: MetaCatalogSyncMode;
  ownership: CatalogOwnershipView;
  /**
   * REALIDAD (no permiso): quién gobierna el catálogo AFUERA hoy, con la sync encendida o
   * apagada. `ownership` de arriba es lo que PODEMOS ESCRIBIR; esto es lo que PASA ALLÁ.
   */
  declared: CatalogDeclaredGovernanceView;
  /** Siempre vacío: este callable NO dispara la detección (no gasta llamadas a Graph). */
  detectedSources: never[];
  /** Última verificación de fuentes externas (ms), o null si nunca corrió. */
  lastSourceCheckAt: number | null;
  /** false ⇒ no existe patch posible: el loop diario es inalcanzable por construcción. */
  hasWritableFields: boolean;
}

/**
 * Arma la respuesta a partir del campo `catalogSync` CRUDO del documento de config. PURA —
 * exportada para testearla sin Firebase ni el envoltorio del callable.
 */
export function buildCatalogOwnershipStatus(rawCatalogSync: unknown): CatalogOwnershipStatusResponse {
  // El MISMO normalizador que usan los gates: si el panel leyera por otro camino podría
  // mostrar verde sobre una propiedad que el servidor degrada (o al revés).
  const cfg = normalizeCatalogSyncConfig(rawCatalogSync);
  // `lastSourceCheckAt` no sobrevive a la normalización (que solo expone la propiedad
  // efectiva), así que se lee del documento crudo — es metadata, no permiso.
  const ownRaw = (rawCatalogSync as { ownership?: { lastSourceCheckAt?: unknown } } | null | undefined)?.ownership;
  // EJE REALIDAD: la MISMA lectura sin gate que usa la proyección de deriva
  // (`declaredExternalFields`), acá con la declaración humana incluida. Va aparte a propósito: si
  // se mezclara con `ownership`, un `enabled:false` volvería a apagar la honestidad junto con la
  // escritura, y con `enabled:true` los dos ejes coinciden, así que nadie ve una respuesta rara.
  const declarado = declaredExternalGovernance(rawCatalogSync);
  return {
    ok: true,
    enabled: cfg.enabled,
    configMode: cfg.mode,
    effectiveMode: effectiveMode(cfg.mode, cfg.ownership),
    ownership: ownershipView(cfg.ownership),
    declared: { externalFields: declarado.fields, externalSource: externalSourceView(declarado.source) },
    detectedSources: [],
    lastSourceCheckAt: aMillis(ownRaw && typeof ownRaw === 'object' ? ownRaw.lastSourceCheckAt : null),
    hasWritableFields: cfg.ownership.writable.length > 0,
  };
}

/** Leer la propiedad es manager+ (espejo de metaCatalogVerificationStatus). Escribirla es owner. */
function authorizeManager(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

export const metaCatalogOwnershipStatus = onCall<{ tenantId?: string }>({ region: REGION }, async (req) => {
  const tenantId = authorizeManager(req, req.data?.tenantId);
  const snap = await db().doc(`tenants/${tenantId}/config/meta`).get();
  return buildCatalogOwnershipStatus((snap.data() as { catalogSync?: unknown } | undefined)?.catalogSync);
});
