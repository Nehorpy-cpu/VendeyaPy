/**
 * meta/catalogClient.ts — Cliente del Meta Catalog (META-CATALOG-LIVE-1)
 * ======================================================================
 * Cliente INYECTABLE del Graph API de catálogo, siguiendo el patrón de graphClient.ts:
 * en emulador se usa un FAKE alimentado por `metaTestFixtures/catalog` (NUNCA llama a
 * graph.facebook.com); en prod, HTTP real con axios.
 *
 * Seguridad/robustez:
 *  - El token viaja por header Authorization (nunca en URL) y NUNCA se loguea ni se
 *    incluye en mensajes de error. Se resuelve por tenant vía SecretStore (ADR-0009).
 *  - Versión del Graph API CONFIGURABLE server-side (META_CATALOG_GRAPH_VERSION,
 *    default v23.0). Deliberadamente NO se toca la constante global v19.0 de
 *    graphClient/oauth/mediaClient: esa migración es un programa aparte.
 *  - Retry con backoff exponencial SOLO para 429/5xx/errores de red (respeta
 *    Retry-After, máx 3 intentos). Los 4xx funcionales NO se reintentan.
 *  - Escrituras solo vía `items_batch` con method UPDATE (upsert). Este cliente no
 *    expone DELETE: el contrato prohíbe borrar productos de Meta.
 */

import axios from 'axios';
import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';

const DEFAULT_GRAPH_VERSION = 'v23.0';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 15_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // 5000 items: techo del propio items_batch de Meta

/** Campos PÚBLICOS que leemos de Meta para el diff. Nada interno viaja ni vuelve. */
export const REMOTE_ITEM_FIELDS = 'id,retailer_id,name,description,availability,price,image_url,brand';

export interface MetaRemoteCatalogItem {
  /** ID del item en Meta (product item id). */
  id: string;
  retailerId: string;
  name: string;
  description: string;
  availability: string;
  /** Precio formateado por Meta (p.ej. "₲30.000" / "PYG30,000"): comparar solo dígitos. */
  price: string;
  imageUrl: string;
  brand: string;
}

export interface CatalogBatchRequest {
  method: 'UPDATE';
  retailer_id: string;
  data: Record<string, unknown>;
}

export interface CatalogBatchItemError {
  retailerId: string;
  message: string;
}

export interface MetaCatalogClient {
  /** Metadatos del catálogo (lanza MetaCatalogApiError si no existe o no hay permiso). */
  getCatalog(catalogId: string): Promise<{ id: string; name: string }>;
  /** Lista COMPLETA (paginada) de items del catálogo. Lanza si supera el tope soportado. */
  listItems(catalogId: string): Promise<MetaRemoteCatalogItem[]>;
  /** Upserts idempotentes vía items_batch. JAMÁS borra items. */
  submitItemsBatch(catalogId: string, requests: CatalogBatchRequest[]): Promise<{ handles: string[] }>;
  /** Estado best-effort de un batch asíncrono (errores por item si Meta ya los reportó). */
  getBatchStatus(catalogId: string, handle: string): Promise<{ errors: CatalogBatchItemError[] }>;
}

/** Error estructurado y SANEADO (jamás incluye el token). */
export class MetaCatalogApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'missing_token' | 'http',
    readonly status: number | null = null,
    readonly fbCode: number | null = null,
    readonly retriable = false,
  ) {
    super(message);
    this.name = 'MetaCatalogApiError';
  }
}

const maskId = (id: string) => (id.length > 4 ? `…${id.slice(-4)}` : '…');

/** Respuesta mínima del transporte (inyectable para tests del retry). */
export interface CatalogHttpResponse {
  status: number;
  headers: Record<string, unknown>;
  data: unknown;
}
export type CatalogTransport = (req: {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  data?: unknown;
  timeoutMs: number;
}) => Promise<CatalogHttpResponse>;

const axiosTransport: CatalogTransport = async (req) => {
  const res = await axios.request({
    method: req.method,
    url: req.url,
    headers: req.headers,
    data: req.data,
    timeout: req.timeoutMs,
    validateStatus: () => true, // el retry decide por status; axios no lanza por 4xx/5xx
  });
  return { status: res.status, headers: res.headers as Record<string, unknown>, data: res.data };
};

/** Extrae {message, code} del sobre de error del Graph API sin propagar contenido sensible. */
function parseFbError(data: unknown): { message: string; code: number | null } {
  const err = (data as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  const message = typeof err?.message === 'string' ? err.message.slice(0, 300) : 'sin detalle';
  const code = typeof err?.code === 'number' ? err.code : null;
  return { message, code };
}

function retryAfterMs(headers: Record<string, unknown>, attempt: number): number {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const secs = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  return Math.min(400 * 2 ** (attempt - 1), MAX_RETRY_AFTER_MS);
}

export class HttpMetaCatalogClient implements MetaCatalogClient {
  private readonly base: string;
  private readonly transport: CatalogTransport;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly accessToken: string,
    opts?: { version?: string; transport?: CatalogTransport; sleep?: (ms: number) => Promise<void> },
  ) {
    const version = opts?.version ?? process.env.META_CATALOG_GRAPH_VERSION ?? DEFAULT_GRAPH_VERSION;
    this.base = `https://graph.facebook.com/${version}`;
    this.transport = opts?.transport ?? axiosTransport;
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET/POST con retry 429/5xx/red (backoff + Retry-After). El token NUNCA sale en logs/errores. */
  private async request(method: 'GET' | 'POST', url: string, data?: unknown): Promise<unknown> {
    let lastMsg = 'error de red';
    let lastStatus: number | null = null;
    let lastCode: number | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: CatalogHttpResponse | null = null;
      try {
        res = await this.transport({
          method,
          url,
          headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
          data,
          timeoutMs: TIMEOUT_MS,
        });
      } catch {
        lastMsg = 'error de red o timeout';
        lastStatus = null;
        lastCode = null;
      }
      if (res) {
        if (res.status >= 200 && res.status < 300) return res.data;
        const fb = parseFbError(res.data);
        lastMsg = fb.message;
        lastStatus = res.status;
        lastCode = fb.code;
        // 4xx funcional (permisos, campos, catálogo inexistente): NO reintentar.
        if (res.status < 500 && res.status !== 429) {
          throw new MetaCatalogApiError(`Meta Catalog API ${res.status} (code ${fb.code ?? '?'}): ${fb.message}`, 'http', res.status, fb.code, false);
        }
      }
      if (attempt < MAX_ATTEMPTS) {
        const wait = retryAfterMs(res?.headers ?? {}, attempt);
        logger.warn('Meta Catalog API reintentando', { status: lastStatus, attempt, waitMs: wait });
        await this.sleep(wait);
      }
    }
    throw new MetaCatalogApiError(`Meta Catalog API agotó reintentos (${lastStatus ?? 'red'}): ${lastMsg}`, 'http', lastStatus, lastCode, true);
  }

  async getCatalog(catalogId: string): Promise<{ id: string; name: string }> {
    const data = ((await this.request('GET', `${this.base}/${catalogId}?fields=id,name`)) ?? {}) as { id?: string; name?: string };
    return { id: String(data.id ?? catalogId), name: String(data.name ?? '') };
  }

  async listItems(catalogId: string): Promise<MetaRemoteCatalogItem[]> {
    const items: MetaRemoteCatalogItem[] = [];
    let url: string | null = `${this.base}/${catalogId}/products?fields=${REMOTE_ITEM_FIELDS}&limit=${PAGE_LIMIT}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const data = ((await this.request('GET', url)) ?? {}) as {
        data?: Array<Record<string, unknown>>;
        paging?: { next?: string };
      };
      for (const raw of data.data ?? []) {
        items.push({
          id: String(raw.id ?? ''),
          retailerId: String(raw.retailer_id ?? ''),
          name: String(raw.name ?? ''),
          description: String(raw.description ?? ''),
          availability: String(raw.availability ?? ''),
          price: String(raw.price ?? ''),
          imageUrl: String(raw.image_url ?? ''),
          brand: String(raw.brand ?? ''),
        });
      }
      const next = data.paging?.next ?? null; // paging.next NO trae el token (va por header)
      if (next && !next.startsWith('https://graph.facebook.com/')) {
        // Jamás seguir un cursor fuera del Graph API con el Bearer puesto.
        throw new MetaCatalogApiError('Meta Catalog: cursor de paginación con host inesperado; corrida abortada.', 'http', null, null, false);
      }
      url = next;
    }
    if (url) {
      // FAIL-CLOSED: con el listado truncado, el plan y la verificación mentirían
      // (creates espurios, disables omitidos, pending falsos). Se aborta la corrida.
      throw new MetaCatalogApiError(`Meta Catalog: el catálogo supera el tope soportado de ${PAGE_LIMIT * MAX_PAGES} items; corrida abortada para no planificar con datos parciales.`, 'http', null, null, false);
    }
    return items;
  }

  async submitItemsBatch(catalogId: string, requests: CatalogBatchRequest[]): Promise<{ handles: string[] }> {
    const data = ((await this.request('POST', `${this.base}/${catalogId}/items_batch`, {
      item_type: 'PRODUCT_ITEM',
      requests,
    })) ?? {}) as { handles?: unknown[] };
    return { handles: (data.handles ?? []).map(String) };
  }

  async getBatchStatus(catalogId: string, handle: string): Promise<{ errors: CatalogBatchItemError[] }> {
    const data = ((await this.request('GET', `${this.base}/${catalogId}/check_batch_request_status?handle=${encodeURIComponent(handle)}`)) ?? {}) as {
      data?: Array<Record<string, unknown>>;
    };
    const errors: CatalogBatchItemError[] = [];
    for (const entry of data.data ?? []) {
      const raw = Array.isArray(entry.errors) ? entry.errors : [];
      for (const item of raw) {
        const e = item as Record<string, unknown>;
        errors.push({
          retailerId: typeof e.retailer_id === 'string' ? e.retailer_id : '',
          message: typeof e.message === 'string' ? e.message.slice(0, 300) : 'error de item reportado por Meta',
        });
      }
    }
    return { errors };
  }
}

/**
 * Fixture del fake (doc `metaTestFixtures/catalog`):
 *   { catalog?: {id,name}, items?: [...campos snake_case...], batchHandles?: string[],
 *     failWith?: { op: 'getCatalog'|'listItems'|'batch', status?, code?, message? } }
 * Cada submitItemsBatch queda registrado en la subcolección `metaTestFixtures/catalog/writes`
 * para que el E2E pueda afirmar "dry-run = CERO escrituras".
 */
export interface CatalogFixture {
  catalog?: { id: string; name: string };
  items?: Array<Record<string, unknown>>;
  batchHandles?: string[];
  /** Errores por item que "reporta" el batch asíncrono (simula check_batch_request_status). */
  batchStatusErrors?: Array<{ retailer_id?: string; message?: string }>;
  failWith?: { op: 'getCatalog' | 'listItems' | 'batch'; status?: number; code?: number; message?: string };
}

export class FakeMetaCatalogClient implements MetaCatalogClient {
  constructor(private readonly fx: CatalogFixture) {}

  private failIf(op: 'getCatalog' | 'listItems' | 'batch'): void {
    const f = this.fx.failWith;
    if (f?.op === op) {
      const status = f.status ?? 400;
      throw new MetaCatalogApiError(`Meta Catalog API ${status} (code ${f.code ?? 100}): ${f.message ?? 'fixture error'}`, 'http', status, f.code ?? 100, status === 429 || status >= 500);
    }
  }

  async getCatalog(catalogId: string): Promise<{ id: string; name: string }> {
    this.failIf('getCatalog');
    const cat = this.fx.catalog;
    if (!cat || cat.id !== catalogId) {
      throw new MetaCatalogApiError(`Meta Catalog API 400 (code 100): Unsupported get request (${maskId(catalogId)})`, 'http', 400, 100, false);
    }
    return { id: cat.id, name: cat.name };
  }

  async listItems(_catalogId: string): Promise<MetaRemoteCatalogItem[]> {
    this.failIf('listItems');
    return (this.fx.items ?? []).map((raw) => ({
      id: String(raw.id ?? ''),
      retailerId: String(raw.retailer_id ?? ''),
      name: String(raw.name ?? ''),
      description: String(raw.description ?? ''),
      availability: String(raw.availability ?? ''),
      price: String(raw.price ?? ''),
      imageUrl: String(raw.image_url ?? ''),
      brand: String(raw.brand ?? ''),
    }));
  }

  async submitItemsBatch(catalogId: string, requests: CatalogBatchRequest[]): Promise<{ handles: string[] }> {
    this.failIf('batch');
    await db().collection('metaTestFixtures/catalog/writes').add({
      catalogId,
      requestCount: requests.length,
      requests: requests.map((r) => ({ method: r.method, retailer_id: r.retailer_id, data: r.data })),
      at: Timestamp.now(),
    });
    return { handles: this.fx.batchHandles ?? requests.map((_, i) => `fx-handle-${i}`) };
  }

  async getBatchStatus(_catalogId: string, _handle: string): Promise<{ errors: CatalogBatchItemError[] }> {
    return {
      errors: (this.fx.batchStatusErrors ?? []).map((e) => ({
        retailerId: typeof e.retailer_id === 'string' ? e.retailer_id : '',
        message: typeof e.message === 'string' ? e.message : 'error de item (fixture)',
      })),
    };
  }
}

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** Token por tenant: metaConnections/main.tokenSecretRef → SecretStore. Nunca se loguea. */
export async function resolveMetaCatalogToken(tenantId: string): Promise<string | null> {
  const conn = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data() as
    | { tokenSecretRef?: string }
    | undefined;
  if (!conn?.tokenSecretRef) return null;
  return getSecretStore().get(conn.tokenSecretRef);
}

/** Cliente activo por tenant: fake en emulador; HTTP real (token vía SecretStore) en prod. */
export async function getMetaCatalogClientForTenant(tenantId: string): Promise<MetaCatalogClient> {
  if (isEmulator()) {
    const fx = (await db().doc('metaTestFixtures/catalog').get()).data() as CatalogFixture | undefined;
    return new FakeMetaCatalogClient(fx ?? {});
  }
  const token = await resolveMetaCatalogToken(tenantId);
  if (!token) {
    throw new MetaCatalogApiError('No hay token de Meta configurado para el tenant.', 'missing_token');
  }
  return new HttpMetaCatalogClient(token);
}
