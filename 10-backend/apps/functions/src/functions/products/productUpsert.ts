/**
 * functions/products/productUpsert.ts — Alta/edición de producto + costo privado (Fase 5A · 5C-B)
 * ==============================================================================================
 * Callable con gate de backend para el catálogo. Rol manager+ (resolvePanelAuth), cuota
 * `maxProducts` en CREATE, validación ESTRICTA (whitelist; descarta campos server/sync/
 * entitlements) y, opcionalmente, escribe el costo PRIVADO `productFinancials/{id}` en el MISMO
 * batch (único callable producto + costos). El `costPrice` NUNCA se loguea. Es el ÚNICO camino
 * de escritura del panel: las rules de products están cerradas (`allow write: if false`).
 *
 * (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1) En CADA upsert se RECOMPUTA la calidad
 * server-side sobre el documento resultante (fresh + patch mergeados en memoria) y se escribe
 * `quality` en el mismo batch. Un patch que deja `status: 'ACTIVE'` con bloqueos de VENTA
 * (name_missing / price_invalid) se RECHAZA: activar un producto invendible no es una edición,
 * es un error. La respuesta informa qué observaciones resolvió este guardado y cuáles quedan.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { CatalogQualityProfile, Product } from '@vpw/shared';
import { resolvePanelAuth } from '../../panel/auth.js';
import { assertWithinLimit } from '../../entitlements/entitlements.js';
import { db, paths } from '../../lib/firebase.js';
import { recordAudit } from '../../audit/audit.js';
import { logger } from '../../lib/logger.js';
import { validateProductPatch, validateProductFinancials } from '../../products/validate.js';
import { diffQuality, evaluateProductQuality, localNameSet, normalizeCatalogProfile, saleBlockingCodes } from '../../products/quality.js';
import { refreshCatalogQualityNotification } from '../../products/qualityNotification.js';

function authorizeTenant(req: CallableRequest<unknown>, requestedTenantId?: string): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const r = resolvePanelAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!r.ok) throw new HttpsError(r.code, r.message);
  return r.tenantId;
}

/**
 * Contexto barato para el evaluador: nombres locales (probable_duplicate) + perfil del tenant.
 * `select` trae solo dos campos por doc — no el catálogo entero.
 */
async function qualityContext(tenantId: string, excludeId?: string): Promise<{ localNames: Set<string>; profile: CatalogQualityProfile | null }> {
  const [snap, cfg] = await Promise.all([
    db().collection(paths.products(tenantId)).select('name', 'status').get(),
    db().doc(`tenants/${tenantId}/config/catalog`).get(),
  ]);
  const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as { name?: string; status?: string }) })) as Array<Pick<Product, 'id' | 'name' | 'status'>>;
  return {
    localNames: localNameSet(rows, excludeId),
    profile: normalizeCatalogProfile((cfg.data() as { profile?: unknown } | undefined)?.profile),
  };
}

const esObjeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Réplica en memoria del `set(..., { merge: true })` para los campos que MIRA el evaluador:
 * spread top-level + merge superficial de los sub-mapas parciales (inventory / externalIds /
 * perfume). Alcanza porque la calidad lee valores hoja de esos mapas; `aiFicha` viaja
 * completa por contrato del validador.
 */
function mergedParaCalidad(fresh: Partial<Product>, patch: Record<string, unknown>): Product {
  const out: Record<string, unknown> = { ...fresh, ...patch };
  for (const k of ['inventory', 'externalIds', 'perfume'] as const) {
    const base = (fresh as Record<string, unknown>)[k];
    const nuevo = patch[k];
    if (esObjeto(base) && esObjeto(nuevo)) out[k] = { ...base, ...nuevo };
  }
  return out as unknown as Product;
}

/**
 * El producto RESULTANTE queda ACTIVE con bloqueos de venta ⇒ se rechaza con detalle claro.
 * Se gatea sobre el status del doc mergeado (no sobre el patch): un UPDATE que omite
 * `status` sobre un producto ya ACTIVE también puede dejarlo en venta con precio inválido.
 * Exportado solo para el test del gate.
 */
export function gateActivacionVenta(statusResultante: unknown, bloqueos: string[]): void {
  if (statusResultante === 'ACTIVE' && bloqueos.length) {
    throw new HttpsError(
      'invalid-argument',
      `No se puede activar la venta: ${bloqueos.map((c) => (c === 'name_missing' ? 'falta el nombre' : 'el precio no es válido')).join(' y ')}.`,
    );
  }
}

export const productUpsert = onCall<{ tenantId?: string; id?: string; data?: unknown; financials?: unknown }>(
  { region: 'us-central1' },
  async (req) => {
    const tenantId = authorizeTenant(req, req.data?.tenantId);
    const id = req.data?.id;
    const now = Timestamp.now();

    let product: Record<string, unknown>;
    let financials: Record<string, unknown> | null;
    try {
      product = validateProductPatch(req.data?.data ?? {}, { requireName: !id });
      financials = req.data?.financials !== undefined ? validateProductFinancials(req.data.financials) : null;
    } catch (e) {
      throw new HttpsError('invalid-argument', e instanceof Error ? e.message : 'Producto inválido.');
    }
    const hasFinancials = !!financials && Object.keys(financials).length > 0;

    if (!id) {
      // Crear → valida la cuota de productos del plan (cuenta actual + 1 <= maxProducts).
      await assertWithinLimit(tenantId, 'products', { actorUid: req.auth?.uid });
      const ref = db().collection(paths.products(tenantId)).doc();
      const draft = { ...product, id: ref.id, tenantId, createdAt: now, updatedAt: now };
      const ctx = await qualityContext(tenantId);
      const quality = evaluateProductQuality(draft as unknown as Product, { ...ctx, previous: null, origin: 'editor', now });
      gateActivacionVenta((draft as { status?: unknown }).status, saleBlockingCodes(quality));
      const batch = db().batch();
      // El doc nace SIN merge: `quality` puede ir adentro sin riesgo de resucitar nada.
      batch.set(ref, { ...draft, quality });
      if (hasFinancials) batch.set(db().doc(paths.productFinancial(tenantId, ref.id)), { ...financials, productId: ref.id, tenantId, updatedAt: now }, { merge: true });
      await batch.commit();
      await recordAudit({ tenantId, action: 'product.created', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: ref.id, summary: 'Producto creado (callable)', metadata: { hasFinancials } });
      logger.info('Producto creado (callable)', { tenantId, productId: ref.id });
      if (quality.blocking + quality.warning > 0) await refreshCatalogQualityNotification(tenantId);
      return { ok: true, id: ref.id, created: true, quality: diffQuality(null, quality) };
    }

    // Actualizar → no suma productos (sin cuota).
    // Editar el inventario ES la revisión de stock que pide un producto importado de Meta:
    // se limpia `stockPendingReview` para que pueda habilitarse la sincronización.
    // (META-CATALOG-RECONCILIATION-1; sin esto el importado quedaba en un callejón sin salida.)
    const revisóStock = product.inventory !== undefined ? { stockPendingReview: false } : {};
    const patch = { ...product, ...revisóStock };

    // Recompute de calidad sobre el DOC RESULTANTE: fresh + patch mergeados en memoria.
    const ref = db().doc(paths.product(tenantId, id));
    const [freshSnap, ctx] = await Promise.all([ref.get(), qualityContext(tenantId, String(id))]);
    const fresh = (freshSnap.data() ?? {}) as Partial<Product>;
    const previous = fresh.quality ?? null;
    const merged = mergedParaCalidad(fresh, { ...patch, id, tenantId });
    const quality = evaluateProductQuality(merged, { ...ctx, previous, origin: 'editor', now });
    gateActivacionVenta(merged.status, saleBlockingCodes(quality));

    const batch = db().batch();
    batch.set(ref, { ...patch, id, tenantId, updatedAt: now }, { merge: true });
    // `quality` se REEMPLAZA entero (update, no merge): un merge profundo del mapa
    // `fingerprints` resucitaría observaciones podadas desde el valor viejo de Firestore.
    if (freshSnap.exists) batch.update(ref, { quality });
    else batch.set(ref, { quality }, { merge: true }); // doc nuevo vía "update": no hay mapa viejo
    if (hasFinancials) batch.set(db().doc(paths.productFinancial(tenantId, id)), { ...financials, productId: id, tenantId, updatedAt: now }, { merge: true });
    await batch.commit();
    await recordAudit({ tenantId, action: 'product.updated', actorUid: req.auth?.uid ?? null, targetType: 'product', targetId: id, summary: 'Producto actualizado (callable)', metadata: { hasFinancials } });

    // La campana agregada solo se refresca si CAMBIARON los contadores de este producto
    // (aproximación barata de "cambió el agregado"; el import run la refresca siempre).
    const cambioAgregado = (previous?.blocking ?? 0) !== quality.blocking || (previous?.warning ?? 0) !== quality.warning;
    if (cambioAgregado) await refreshCatalogQualityNotification(tenantId);

    return { ok: true, id, created: false, quality: diffQuality(previous, quality) };
  },
);
