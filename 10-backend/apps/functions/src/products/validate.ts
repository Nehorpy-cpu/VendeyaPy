/**
 * products/validate.ts — Validación ESTRICTA de payloads de catálogo (Fase 5C-B)
 * =============================================================================
 * Funciones PURAS (testeables) patch-style: validan SOLO los campos presentes (whitelist) y
 * descartan los de servidor/sync/entitlements (id, tenantId, createdAt, updatedAt, syncToMeta,
 * metaProductItemId, planId, limits, ...). En CREATE `name` es requerido. Lanzan Error con mensaje
 * claro. El costo (`productFinancials`) se valida aparte y NUNCA se loguea.
 */
import { CURRENCY, PRODUCT_STATUS, PERFUME_GENDER, PRICE_RANGE } from '@vpw/shared';

function asObject(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} inválido/a.`);
  return v as Record<string, unknown>;
}
function str(v: unknown, f: string, max = 1000): string {
  if (typeof v !== 'string') throw new Error(`Campo "${f}" debe ser texto.`);
  if (v.length > max) throw new Error(`Campo "${f}" demasiado largo.`);
  return v;
}
function reqStr(v: unknown, f: string, max = 1000): string {
  const s = str(v, f, max);
  if (!s.trim()) throw new Error(`Campo "${f}" requerido.`);
  return s;
}
function strOrNull(v: unknown, f: string, max = 1000): string | null {
  return v === null ? null : str(v, f, max);
}
function num(v: unknown, f: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Campo "${f}" debe ser número.`);
  return v;
}
function nonNeg(v: unknown, f: string): number {
  const n = num(v, f);
  if (n < 0) throw new Error(`Campo "${f}" no puede ser negativo.`);
  return n;
}
function intNonNeg(v: unknown, f: string): number {
  const n = nonNeg(v, f);
  if (!Number.isInteger(n)) throw new Error(`Campo "${f}" debe ser entero.`);
  return n;
}
function range(v: unknown, min: number, max: number, f: string): number {
  const n = num(v, f);
  if (n < min || n > max) throw new Error(`Campo "${f}" fuera de rango (${min}-${max}).`);
  return n;
}
function bool(v: unknown, f: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`Campo "${f}" debe ser booleano.`);
  return v;
}
function inEnum<T extends readonly string[]>(arr: T, v: unknown, f: string): T[number] {
  if (typeof v !== 'string' || !(arr as readonly string[]).includes(v)) throw new Error(`Campo "${f}" inválido.`);
  return v;
}
function strArray(v: unknown, max: number, f: string, maxLen = 2000): string[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Campo "${f}" debe ser una lista (máx ${max}).`);
  return v.map((x, i) => str(x, `${f}[${i}]`, maxLen));
}

function validateInventory(v: unknown): Record<string, unknown> {
  const d = asObject(v, 'inventory');
  const out: Record<string, unknown> = {};
  if (d.trackStock !== undefined) out.trackStock = bool(d.trackStock, 'inventory.trackStock');
  if (d.stock !== undefined) out.stock = intNonNeg(d.stock, 'inventory.stock');
  if (d.lowStockThreshold !== undefined) out.lowStockThreshold = intNonNeg(d.lowStockThreshold, 'inventory.lowStockThreshold');
  if (d.sku !== undefined) out.sku = str(d.sku, 'inventory.sku', 100);
  return out;
}
function validateExternalIds(v: unknown): Record<string, unknown> {
  const d = asObject(v, 'externalIds');
  const out: Record<string, unknown> = {};
  for (const k of ['facebook', 'instagram', 'tiktok']) {
    if (d[k] !== undefined) out[k] = strOrNull(d[k], `externalIds.${k}`, 300);
  }
  return out;
}
function validatePerfume(v: unknown): Record<string, unknown> {
  const d = asObject(v, 'perfume');
  const out: Record<string, unknown> = {};
  if (d.brand !== undefined) out.brand = str(d.brand, 'perfume.brand', 200);
  if (d.gender !== undefined) out.gender = inEnum(PERFUME_GENDER, d.gender, 'perfume.gender');
  if (d.olfactiveFamily !== undefined) out.olfactiveFamily = str(d.olfactiveFamily, 'perfume.olfactiveFamily', 200);
  if (d.styleTags !== undefined) out.styleTags = strArray(d.styleTags, 30, 'perfume.styleTags', 100);
  if (d.priceRange !== undefined) out.priceRange = inEnum(PRICE_RANGE, d.priceRange, 'perfume.priceRange');
  if (d.sizeMl !== undefined) out.sizeMl = d.sizeMl === null ? null : nonNeg(d.sizeMl, 'perfume.sizeMl');
  if (d.isNew !== undefined) out.isNew = bool(d.isNew, 'perfume.isNew');
  if (d.notes !== undefined) {
    const n = asObject(d.notes, 'perfume.notes');
    const notes: Record<string, unknown> = {};
    for (const k of ['top', 'heart', 'base']) if (n[k] !== undefined) notes[k] = strArray(n[k], 50, `perfume.notes.${k}`, 100);
    out.notes = notes;
  }
  return out;
}

/**
 * Ficha para recomendaciones (CAT-1): whitelist estricta, textos acotados.
 * La ficha viaja COMPLETA desde el form (no es un patch por campo): las claves ausentes se
 * normalizan a ''/[]  para que el set(..., {merge:true}) del upsert las PISE — si quedaran
 * ausentes, el merge profundo de mapas de Firestore resucitaría el valor viejo al "borrar".
 */
function validateAiFicha(v: unknown): Record<string, unknown> {
  const d = asObject(v, 'aiFicha');
  const out: Record<string, unknown> = {};
  for (const k of ['cuandoRecomendar', 'cuandoNoRecomendar', 'objeciones', 'concentracion', 'duracion', 'proyeccion', 'perfil'] as const) {
    out[k] = d[k] !== undefined ? str(d[k], `aiFicha.${k}`, 500) : '';
  }
  for (const k of ['frasesVenta', 'similares', 'ocasiones', 'clima'] as const) {
    out[k] = d[k] !== undefined ? strArray(d[k], 20, `aiFicha.${k}`, 200) : [];
  }
  return out;
}

/** Patch sanitizado de Product (solo campos permitidos). `requireName` en CREATE. */
export function validateProductPatch(data: unknown, opts: { requireName: boolean }): Record<string, unknown> {
  const d = asObject(data, 'producto');
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = reqStr(d.name, 'name', 300);
  else if (opts.requireName) throw new Error('El producto necesita un nombre.');
  if (d.description !== undefined) out.description = str(d.description, 'description', 5000);
  if (d.aiNotes !== undefined) out.aiNotes = str(d.aiNotes, 'aiNotes', 5000);
  if (d.categoryId !== undefined) out.categoryId = str(d.categoryId, 'categoryId', 200);
  if (d.emoji !== undefined) out.emoji = str(d.emoji, 'emoji', 16);
  if (d.currency !== undefined) out.currency = inEnum(CURRENCY, d.currency, 'currency');
  if (d.status !== undefined) out.status = inEnum(PRODUCT_STATUS, d.status, 'status');
  if (d.price !== undefined) out.price = nonNeg(d.price, 'price');
  if (d.compareAtPrice !== undefined) out.compareAtPrice = d.compareAtPrice === null ? null : nonNeg(d.compareAtPrice, 'compareAtPrice');
  if (d.position !== undefined) out.position = num(d.position, 'position');
  if (d.featured !== undefined) out.featured = bool(d.featured, 'featured');
  if (d.images !== undefined) out.images = strArray(d.images, 12, 'images');
  if (d.inventory !== undefined) out.inventory = validateInventory(d.inventory);
  if (d.externalIds !== undefined) out.externalIds = validateExternalIds(d.externalIds);
  if (d.perfume !== undefined) out.perfume = d.perfume === null ? null : validatePerfume(d.perfume);
  if (d.aiFicha !== undefined) out.aiFicha = d.aiFicha === null ? null : validateAiFicha(d.aiFicha);
  if (typeof out.price === 'number' && typeof out.compareAtPrice === 'number' && out.compareAtPrice < out.price) {
    throw new Error('compareAtPrice debe ser mayor o igual a price.');
  }
  return out;
}

/** Costo PRIVADO (productFinancials). Solo campos permitidos. Nunca se loguea. */
export function validateProductFinancials(data: unknown): Record<string, unknown> {
  const d = asObject(data, 'costos');
  const out: Record<string, unknown> = {};
  if (d.costPrice !== undefined) out.costPrice = d.costPrice === null ? null : nonNeg(d.costPrice, 'costPrice');
  if (d.priorityScore !== undefined) out.priorityScore = d.priorityScore === null ? null : range(d.priorityScore, 0, 10, 'priorityScore');
  if (d.targetMargin !== undefined) out.targetMargin = d.targetMargin === null ? null : num(d.targetMargin, 'targetMargin');
  if (d.allowDiscount !== undefined) out.allowDiscount = d.allowDiscount === null ? null : bool(d.allowDiscount, 'allowDiscount');
  if (d.maxDiscountPercentage !== undefined) out.maxDiscountPercentage = d.maxDiscountPercentage === null ? null : range(d.maxDiscountPercentage, 0, 100, 'maxDiscountPercentage');
  return out;
}

/** Patch sanitizado de Category. `requireName` en CREATE. */
export function validateCategoryPatch(data: unknown, opts: { requireName: boolean }): Record<string, unknown> {
  const d = asObject(data, 'categoría');
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = reqStr(d.name, 'name', 200);
  else if (opts.requireName) throw new Error('La categoría necesita un nombre.');
  if (d.description !== undefined) out.description = str(d.description, 'description', 2000);
  if (d.emoji !== undefined) out.emoji = str(d.emoji, 'emoji', 16);
  if (d.position !== undefined) out.position = num(d.position, 'position');
  if (d.isActive !== undefined) out.isActive = bool(d.isActive, 'isActive');
  return out;
}
