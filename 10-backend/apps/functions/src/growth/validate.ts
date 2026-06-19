/**
 * growth/validate.ts — Validación ESTRICTA de promociones y tracking (Fase 5C-C1)
 * ===============================================================================
 * Funciones PURAS patch-style (whitelist; solo campos presentes). Requeridos en CREATE:
 * promo → name+type; tracking → name+code+type. Descartan server-only (id, tenantId, timestamps,
 * attribution/rollups). Las fechas se devuelven como epoch ms|null (el callable las pasa a Timestamp).
 */
import { PROMOTION_TYPE, PROMOTION_STATUS, TRACKING_TYPE } from '@vpw/shared';

function asObject(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} inválido/a.`);
  return v as Record<string, unknown>;
}
function str(v: unknown, f: string, max = 2000): string {
  if (typeof v !== 'string') throw new Error(`Campo "${f}" debe ser texto.`);
  if (v.length > max) throw new Error(`Campo "${f}" demasiado largo.`);
  return v;
}
function reqStr(v: unknown, f: string, max = 2000): string {
  const s = str(v, f, max);
  if (!s.trim()) throw new Error(`Campo "${f}" requerido.`);
  return s;
}
function nonNeg(v: unknown, f: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Campo "${f}" debe ser número.`);
  if (v < 0) throw new Error(`Campo "${f}" no puede ser negativo.`);
  return v;
}
function bool(v: unknown, f: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`Campo "${f}" debe ser booleano.`);
  return v;
}
function inEnum<T extends readonly string[]>(arr: T, v: unknown, f: string): T[number] {
  if (typeof v !== 'string' || !(arr as readonly string[]).includes(v)) throw new Error(`Campo "${f}" inválido.`);
  return v;
}
function strArray(v: unknown, max: number, f: string, maxLen = 200): string[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Campo "${f}" debe ser una lista (máx ${max}).`);
  return v.map((x, i) => str(x, `${f}[${i}]`, maxLen));
}
/** epoch ms | ISO string | null → ms | null. */
function dateMs(v: unknown, f: string): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`Campo "${f}" debe ser fecha (epoch ms, ISO o null).`);
}

/** Patch sanitizado de Promotion. `requireCreate` exige name+type. `startDate`/`endDate` salen como ms|null. */
export function validatePromotionPatch(data: unknown, opts: { requireCreate: boolean }): Record<string, unknown> {
  const d = asObject(data, 'promoción');
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = reqStr(d.name, 'name', 200);
  else if (opts.requireCreate) throw new Error('La promoción necesita un nombre.');
  if (d.type !== undefined) out.type = inEnum(PROMOTION_TYPE, d.type, 'type');
  else if (opts.requireCreate) throw new Error('La promoción necesita un tipo.');
  if (d.description !== undefined) out.description = str(d.description, 'description', 5000);
  if (d.objective !== undefined) out.objective = str(d.objective, 'objective', 2000);
  if (d.discountValue !== undefined) out.discountValue = nonNeg(d.discountValue, 'discountValue');
  if (d.productIds !== undefined) out.productIds = strArray(d.productIds, 1000, 'productIds');
  if (d.categoryIds !== undefined) out.categoryIds = strArray(d.categoryIds, 200, 'categoryIds');
  if (d.startDate !== undefined) out.startDate = dateMs(d.startDate, 'startDate');
  if (d.endDate !== undefined) out.endDate = dateMs(d.endDate, 'endDate');
  if (d.status !== undefined) out.status = inEnum(PROMOTION_STATUS, d.status, 'status');
  return out;
}

/** Patch sanitizado de TrackingSource. `requireCreate` exige name+code+type. Descarta `attribution`. */
export function validateTrackingSourcePatch(data: unknown, opts: { requireCreate: boolean }): Record<string, unknown> {
  const d = asObject(data, 'fuente de tracking');
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = reqStr(d.name, 'name', 200);
  else if (opts.requireCreate) throw new Error('La fuente necesita un nombre.');
  if (d.code !== undefined) out.code = reqStr(d.code, 'code', 100);
  else if (opts.requireCreate) throw new Error('La fuente necesita un código.');
  if (d.type !== undefined) out.type = inEnum(TRACKING_TYPE, d.type, 'type');
  else if (opts.requireCreate) throw new Error('La fuente necesita un tipo.');
  if (d.active !== undefined) out.active = bool(d.active, 'active');
  return out;
}
