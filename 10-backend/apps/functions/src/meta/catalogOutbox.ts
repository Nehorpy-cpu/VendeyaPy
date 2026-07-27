/**
 * meta/catalogOutbox.ts — Núcleo PURO del outbox de escrituras VendeyaPy → Meta Catalog
 * =====================================================================================
 * (META-CATALOG-OUTBOX-1) `catalogSyncApply` dejó de escribir en Meta: cada acción CREATE /
 * UPDATE / DISABLE se convierte en un JOB PERSISTIDO que un worker reclama, envía y
 * reconcilia. Este módulo contiene lo que se puede decidir SIN tocar Firestore ni la red:
 *
 *  - la IDENTIDAD determinística e inyectiva del job (dos confirmaciones idénticas ⇒ un job);
 *  - la VERIFICACIÓN DE TRES ESTADOS de cada campo gestionado —el punto que corrige la
 *    semántica anterior: si mandamos `link` y Meta no devuelve `url`, el resultado es
 *    `unverifiable`, JAMÁS `confirmed_equal`. Un `synced` solo se declara con evidencia;
 *  - el GATE fail-closed que decide, antes de cualquier escritura, si el job todavía
 *    corresponde (config, tenant, catálogo, opt-in y snapshot del producto);
 *  - la clasificación del error de envío: la AMBIGÜEDAD nunca se reintenta a ciegas.
 *
 * El estado transaccional (claim, lease, fencing, settlement) vive en `catalogOutboxWorker.ts`,
 * que reusa el patrón ya probado de la saga de cotización (`functions/coverage/coverageQuote.ts`).
 *
 * PRIVACIDAD: un job SOLO guarda el patch público que ya pasó por el contrato de escritura
 * (`catalogOutbound.ts`). Jamás tokens, costo, margen, `aiNotes`, `aiFicha`, datos bancarios,
 * de Coverage ni de clientes.
 */

import { createHash } from 'node:crypto';
import type { Timestamp } from 'firebase-admin/firestore';
import type { MetaSyncStatus } from '@vpw/shared';
import { MetaCatalogApiError, type MetaRemoteCatalogItem } from './catalogClient.js';
import { canonicalHttpsUrl, WRITABLE_FIELDS, type CatalogBatchMethod } from './catalogOutbound.js';

// ---------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------

/** Acción de catálogo que un job materializa. `disable` viaja como UPDATE de availability. */
export type CatalogOutboxAction = 'create' | 'update' | 'disable';

/**
 * Estados del job.
 *  - `queued`      esperando worker.
 *  - `processing`  reclamado con lease vigente (un solo worker).
 *  - `submitted`   Meta ACEPTÓ el lote y devolvió handle. Aceptación ≠ éxito comercial:
 *                  falta la confirmación diferida. Jamás se declara `synced` acá.
 *  - `succeeded`   todos los campos del patch quedaron `confirmed_equal` contra Meta.
 *  - `failed`      error confirmado (Meta rechazó el item o el patch no cumple el contrato).
 *  - `cancelled`   el job dejó de corresponder (producto sin opt-in, borrado, stock sin revisar).
 *  - `held`        la configuración no permite escribir (off / dry_run). Reintentable solo.
 *  - `stale`       el producto cambió desde el preview: exige una confirmación nueva.
 *  - `needs_action` requiere una decisión humana (catálogo distinto, divergencia confirmada).
 *  - `needs_reconciliation` no se pudo determinar si Meta aplicó el cambio. JAMÁS reintento ciego.
 */
export type MetaCatalogOutboxStatus =
  | 'queued'
  | 'processing'
  | 'submitted'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'held'
  | 'stale'
  | 'needs_action'
  | 'needs_reconciliation';

/** Estados que nadie vuelve a mover automáticamente. Un job terminal jamás se reescribe. */
const TERMINALES: readonly MetaCatalogOutboxStatus[] = ['succeeded', 'failed', 'cancelled', 'stale'];

export function isTerminalOutboxStatus(s: MetaCatalogOutboxStatus): boolean {
  return TERMINALES.includes(s);
}

export interface MetaCatalogOutboxJob {
  id: string;
  tenantId: string;
  catalogId: string;
  productId: string;
  /** Identidad remota EXACTA (nunca truncada — ADR-0012 §9). */
  retailerId: string;
  action: CatalogOutboxAction;
  /** `data` del request de escritura, ya normalizado por el contrato. Solo campos públicos. */
  intendedPatch: Record<string, unknown>;
  intendedContentHash: string;
  /** Hash de la vista pública del producto que originó el job (detección de `stale`). */
  productSnapshotHash: string;
  /** Corrida de preview que lo encoló (trazabilidad). */
  runId: string;
  requestedByUid: string | null;
  requestedByRole: string | null;
  status: MetaCatalogOutboxStatus;
  /** GENERACIÓN del claim: todo settlement exige presentarla (fencing de workers zombis). */
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: Timestamp | null;
  /** Handle del batch aceptado por Meta. Se persiste ANTES de cualquier seguimiento. */
  batchHandle: string | null;
  /** Motivo estructurado del estado actual (para el panel; sin datos sensibles). */
  reason: OutboxReason | null;
  /** Detalle SANEADO del error. Jamás token ni datos internos. */
  error: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  submittedAt: Timestamp | null;
  reconciledAt: Timestamp | null;
}

export type OutboxReason =
  | 'config_disabled'
  | 'mode_not_live'
  | 'catalog_mismatch'
  | 'tenant_mismatch'
  | 'product_missing'
  | 'sync_disabled'
  | 'stock_pending_review'
  | 'product_changed'
  | 'contract_violation'
  | 'item_rejected'
  | 'remote_differs'
  | 'submit_ambiguous'
  | 'verification_unavailable'
  | 'rate_limited';

// ---------------------------------------------------------------------------
// Identidad determinística
// ---------------------------------------------------------------------------

/** JSON canónico: claves ordenadas en todo el árbol. `undefined` se descarta como en JSON. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const claves = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Hash estable de un objeto: mismo contenido ⇒ mismo hash, sin importar el orden de claves. */
export function stableHash(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v)).digest('hex');
}

export interface OutboxJobKey {
  tenantId: string;
  catalogId: string;
  retailerId: string;
  action: CatalogOutboxAction;
  intendedContentHash: string;
}

/**
 * Id de documento del job. Determinístico e INYECTIVO: cada componente va con su largo
 * adelante, así `('a|b','c')` y `('a','b|c')` jamás colisionan. Concatenar con un separador
 * (el error clásico) haría que dos claves distintas produjeran el mismo documento y una
 * confirmación pisara a otra.
 */
export function outboxJobId(k: OutboxJobKey): string {
  const partes = [k.tenantId, k.catalogId, k.retailerId, k.action, k.intendedContentHash];
  const material = partes.map((p) => `${p.length}:${p}`).join('');
  return `mco_${createHash('sha256').update(material).digest('hex').slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Verificación honesta de TRES estados
// ---------------------------------------------------------------------------

/**
 * `confirmed_equal`     Meta devolvió el campo y coincide con lo que mandamos.
 * `confirmed_different` Meta devolvió el campo y NO coincide.
 * `unverifiable`        Meta no devolvió el campo (o el artículo no aparece): no hay evidencia.
 *
 * La tercera es la que faltaba. Tratar "no vino" como "coincide" produce `synced` falsos: el
 * artículo podía no haberse escrito nunca.
 */
export type FieldVerdict = 'confirmed_equal' | 'confirmed_different' | 'unverifiable';

const soloDigitos = (s: string) => s.replace(/\D+/g, '');

/** Valor remoto de cada campo del contrato de ESCRITURA, leído del contrato de LECTURA. */
function remoteValueOf(field: string, remote: MetaRemoteCatalogItem): string {
  switch (field) {
    case 'title': return remote.name ?? '';
    case 'description': return remote.description ?? '';
    case 'link': return remote.url ?? '';
    case 'price': return remote.price ?? '';
    case 'availability': return remote.availability ?? '';
    case 'brand': return remote.brand ?? '';
    case 'image': return remote.imageUrl ?? '';
    case 'condition': return remote.condition ?? '';
    default: return '';
  }
}

/** Valor enviado, normalizado a la forma comparable con lo que Meta devuelve al leer. */
function sentValueOf(field: string, sent: unknown): string {
  if (field === 'image') {
    const primera = Array.isArray(sent) ? (sent[0] as { url?: unknown } | undefined) : undefined;
    return String(primera?.url ?? '');
  }
  return String(sent ?? '');
}

export function verifyManagedField(field: string, sent: unknown, remote: MetaRemoteCatalogItem | null): FieldVerdict {
  // El artículo no aparece en el GET: no hay NADA que confirmar.
  if (!remote) return 'unverifiable';
  if (!(WRITABLE_FIELDS as readonly string[]).includes(field)) return 'unverifiable';

  const esperado = sentValueOf(field, sent);
  const obtenido = remoteValueOf(field, remote);
  // Meta no expone el campo en la lectura ⇒ sin evidencia. Nunca se asume que coincide.
  if (!obtenido) return 'unverifiable';

  if (field === 'price') {
    // La MONEDA declarada manda: sin esto "250000 PYG" y "250000 USD" tendrían los mismos
    // dígitos y el precio figuraría confirmado siendo otro.
    const monedaLocal = esperado.match(/[A-Z]{3}\s*$/)?.[0]?.trim();
    const monedaRemota = (remote.currency ?? '').trim();
    if (monedaLocal && monedaRemota && monedaLocal !== monedaRemota) return 'confirmed_different';
    // Meta formatea el precio ("₲250.000", "PYG250,000"): la comparación es por dígitos.
    const a = soloDigitos(esperado);
    const b = soloDigitos(obtenido);
    if (!a || !b) return 'unverifiable';
    return a === b ? 'confirmed_equal' : 'confirmed_different';
  }
  if (field === 'link') {
    // Meta normaliza la URL que recibe: se comparan formas canónicas de ambos lados.
    const a = canonicalHttpsUrl(esperado) ?? esperado;
    const b = canonicalHttpsUrl(obtenido) ?? obtenido;
    return a === b ? 'confirmed_equal' : 'confirmed_different';
  }
  return esperado === obtenido ? 'confirmed_equal' : 'confirmed_different';
}

export interface JobVerification {
  verdicts: Record<string, FieldVerdict>;
  outcome: FieldVerdict;
}

/**
 * Verifica EXCLUSIVAMENTE los campos que el patch mandó. Un UPDATE de solo precio se confirma
 * con el precio: exigirle coincidencia a campos que nunca viajaron dejaría al job atascado por
 * diferencias que este sistema no administra.
 *
 * Precedencia: una divergencia confirmada manda sobre la falta de evidencia; y sin ningún campo
 * verificable el resultado es `unverifiable` — jamás `confirmed_equal` por defecto.
 */
export function verifyJobOutcome(patch: Record<string, unknown>, remote: MetaRemoteCatalogItem | null): JobVerification {
  const verdicts: Record<string, FieldVerdict> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue; // identidad, no contenido
    verdicts[k] = verifyManagedField(k, v, remote);
  }
  const valores = Object.values(verdicts);
  const outcome: FieldVerdict = valores.includes('confirmed_different')
    ? 'confirmed_different'
    : valores.length > 0 && valores.every((v) => v === 'confirmed_equal')
      ? 'confirmed_equal'
      : 'unverifiable';
  return { verdicts, outcome };
}

// ---------------------------------------------------------------------------
// Gate: qué se decide ANTES de tocar Meta
// ---------------------------------------------------------------------------

export interface OutboxGateContext {
  /** Tenant que está PROCESANDO el job. Si no es el dueño, no se evalúa nada más. */
  tenantId: string;
  config: { enabled: boolean; mode: 'off' | 'dry_run' | 'live'; catalogId: string };
  /** `null` = el producto ya no existe. */
  product: { exists: boolean; syncToMeta?: boolean; stockPendingReview?: boolean; snapshotHash: string } | null;
}

export type OutboxGateResult =
  | { go: true }
  | { go: false; status: Extract<MetaCatalogOutboxStatus, 'held' | 'cancelled' | 'stale' | 'needs_action'>; reason: OutboxReason };

/**
 * Decisión PURA previa a cualquier escritura. El orden importa y es fail-closed: primero lo que
 * apaga TODO el flujo (config), después el aislamiento (tenant/catálogo), después la vigencia
 * del producto y por último la del contenido. Con la config apagada no se evalúa nada más:
 * un kill-switch tiene que ganar siempre.
 *
 * Se ejecuta DOS veces: fuera y DENTRO de la transacción del claim (el estado pudo cambiar en
 * el medio) — mismo estándar que el claim de la saga de cotización.
 */
export function outboxGate(job: Pick<MetaCatalogOutboxJob, 'tenantId' | 'catalogId' | 'productSnapshotHash'>, ctx: OutboxGateContext): OutboxGateResult {
  // AISLAMIENTO DE TENANT, primero de todo: procesar un job ajeno significaría haber leído la
  // config y el producto del tenant equivocado, así que ninguna otra verificación vale nada.
  if (job.tenantId !== ctx.tenantId) return { go: false, status: 'needs_action', reason: 'tenant_mismatch' };
  if (!ctx.config.enabled) return { go: false, status: 'held', reason: 'config_disabled' };
  if (ctx.config.mode !== 'live') return { go: false, status: 'held', reason: 'mode_not_live' };
  if (ctx.config.catalogId !== job.catalogId) return { go: false, status: 'needs_action', reason: 'catalog_mismatch' };
  if (!ctx.product || !ctx.product.exists) return { go: false, status: 'cancelled', reason: 'product_missing' };
  if (ctx.product.syncToMeta !== true) return { go: false, status: 'cancelled', reason: 'sync_disabled' };
  if (ctx.product.stockPendingReview === true) return { go: false, status: 'cancelled', reason: 'stock_pending_review' };
  if (ctx.product.snapshotHash !== job.productSnapshotHash) return { go: false, status: 'stale', reason: 'product_changed' };
  return { go: true };
}

// ---------------------------------------------------------------------------
// Error de envío: la ambigüedad se trata como ambigüedad
// ---------------------------------------------------------------------------

/**
 * `confirmed_not_applied` Meta rechazó la llamada (4xx funcional): NADA se escribió.
 * `rate_limited`          429 agotado: tampoco se escribió, pero conviene esperar.
 * `ambiguous`             5xx, red o timeout: el POST PUDO haberse aplicado. Antes de
 *                         cualquier reintento hay que MIRAR el estado remoto.
 */
export type SubmitErrorClass = 'confirmed_not_applied' | 'rate_limited' | 'ambiguous';

export function classifySubmitError(e: unknown): SubmitErrorClass {
  if (e instanceof MetaCatalogApiError) {
    if (e.status === 429) return 'rate_limited';
    if (!e.retriable && e.status !== null && e.status >= 400 && e.status < 500) return 'confirmed_not_applied';
  }
  // Cualquier otra cosa (incluida una excepción desconocida) es ambigua por definición.
  return 'ambiguous';
}

// ---------------------------------------------------------------------------
// Chunking: por cantidad Y por tamaño serializado
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  maxJobs: number;
  maxBytes: number;
}

/**
 * Arma el próximo lote respetando ambos topes. Un job que por sí solo excede `maxBytes` viaja
 * SOLO en su lote: descartarlo lo dejaría atascado para siempre, y meterlo con otros haría
 * fallar un lote entero por culpa de uno.
 */
export function chunkJobsForBatch<T extends { intendedPatch: Record<string, unknown> }>(
  jobs: readonly T[],
  opts: ChunkOptions,
): { chunk: T[]; resto: T[] } {
  const chunk: T[] = [];
  let bytes = 0;
  let i = 0;
  for (; i < jobs.length; i++) {
    if (chunk.length >= opts.maxJobs) break;
    const tam = Buffer.byteLength(canonicalJson(jobs[i]!.intendedPatch), 'utf8');
    if (chunk.length > 0 && bytes + tam > opts.maxBytes) break;
    chunk.push(jobs[i]!);
    bytes += tam;
    if (bytes > opts.maxBytes) { i++; break; } // el job gigante viajó solo
  }
  return { chunk, resto: jobs.slice(i) };
}

// ---------------------------------------------------------------------------
// Proyección al producto (lo que ve el usuario en el panel)
// ---------------------------------------------------------------------------

/**
 * Estado que se le muestra al vendedor. `submitted` sigue siendo "procesando": Meta aceptó el
 * lote pero todavía no confirmó nada — decirle "confirmado" ahí sería exactamente el "aplicado"
 * mentiroso que este programa vino a eliminar.
 */
export function productStatusForJob(job: Pick<MetaCatalogOutboxJob, 'status' | 'action'>): MetaSyncStatus {
  switch (job.status) {
    case 'queued':
    case 'held':
      return 'queued';
    case 'processing':
    case 'submitted':
      return 'processing';
    case 'succeeded':
      return job.action === 'disable' ? 'disabled' : 'synced';
    case 'failed':
      return 'failed';
    case 'stale':
    case 'needs_action':
    case 'needs_reconciliation':
      return 'needs_review';
    case 'cancelled':
      // El producto salió de la sincronización por decisión administrativa: no es un error suyo.
      return 'not_synced';
  }
}

/** Método de escritura que corresponde a la acción del job. Nunca DELETE (ADR-0012 §10). */
export function methodForAction(action: CatalogOutboxAction): CatalogBatchMethod {
  return action === 'create' ? 'CREATE' : 'UPDATE';
}
