/**
 * growth/validate.ts — Validación ESTRICTA de promociones y tracking (Fase 5C-C1)
 * ===============================================================================
 * Funciones PURAS patch-style (whitelist; solo campos presentes). Requeridos en CREATE:
 * promo → name+type; tracking → name+code+type. Descartan server-only (id, tenantId, timestamps,
 * attribution/rollups). Las fechas se devuelven como epoch ms|null (el callable las pasa a Timestamp).
 */
import { PROMOTION_TYPE, PROMOTION_STATUS, TRACKING_TYPE, DRIVER_STATUS, REPLY_STATUS, AGENTTEST_STATUS } from '@vpw/shared';

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

/** Patch sanitizado de DeliveryPerson. `requireCreate` exige name+whatsappPhone. Descarta server-only. */
export function validateDeliveryPersonPatch(data: unknown, opts: { requireCreate: boolean }): Record<string, unknown> {
  const d = asObject(data, 'repartidor');
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = reqStr(d.name, 'name', 200);
  else if (opts.requireCreate) throw new Error('El repartidor necesita un nombre.');
  if (d.whatsappPhone !== undefined) out.whatsappPhone = reqStr(d.whatsappPhone, 'whatsappPhone', 40);
  else if (opts.requireCreate) throw new Error('El repartidor necesita un teléfono.');
  if (d.status !== undefined) out.status = inEnum(DRIVER_STATUS, d.status, 'status');
  if (d.isActive !== undefined) out.isActive = bool(d.isActive, 'isActive');
  if (d.area !== undefined) out.area = str(d.area, 'area', 500);
  return out;
}

/** Patch sanitizado de WinningReply (solo manual). Descarta `source`/`conversions`. */
export function validateWinningReplyPatch(data: unknown, opts: { requireCreate: boolean }): Record<string, unknown> {
  const d = asObject(data, 'respuesta');
  const out: Record<string, unknown> = {};
  if (d.text !== undefined) out.text = reqStr(d.text, 'text', 5000);
  else if (opts.requireCreate) throw new Error('La respuesta necesita texto.');
  if (d.category !== undefined) out.category = str(d.category, 'category', 200);
  if (d.status !== undefined) out.status = inEnum(REPLY_STATUS, d.status, 'status');
  return out;
}

/** Patch sanitizado de AgentTestCase (definición). Descarta `lastResult`/`lastRunAt`. */
export function validateAgentTestCasePatch(data: unknown, opts: { requireCreate: boolean }): Record<string, unknown> {
  const d = asObject(data, 'caso de prueba');
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = reqStr(d.name, 'name', 200);
  else if (opts.requireCreate) throw new Error('El caso necesita un nombre.');
  if (d.scenario !== undefined) out.scenario = str(d.scenario, 'scenario', 2000);
  if (d.userMessage !== undefined) out.userMessage = str(d.userMessage, 'userMessage', 2000);
  if (d.expectedBehavior !== undefined) out.expectedBehavior = str(d.expectedBehavior, 'expectedBehavior', 2000);
  if (d.status !== undefined) out.status = inEnum(AGENTTEST_STATUS, d.status, 'status');
  return out;
}
