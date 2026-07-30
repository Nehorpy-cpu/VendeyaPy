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
 *  - Este cliente solo TRANSPORTA: los requests los serializa `catalogOutbound.ts`
 *    (contrato de escritura: CREATE / UPDATE parcial / disable por availability).
 *    Ningún builder emite DELETE y el fake lo rechaza: borrar es una operación aparte.
 *  - DETECCIÓN DE FUENTES EXTERNAS (ADR-0015 §4): `listDataSources` lee los data sources del
 *    catálogo por GET y devuelve SOLO metadata SANEADA. La URL del schedule lleva el token en
 *    el query string —y a veces en el path—, así que de ella sobrevive únicamente el hostname:
 *    nada más se devuelve, se loguea ni se persiste.
 */

import axios from 'axios';
import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';
import { canonicalHttpsUrl, ITEMS_BATCH_ALLOW_UPSERT, ITEMS_BATCH_ITEM_TYPE, MAX_ID_LENGTH, type CatalogBatchRequest } from './catalogOutbound.js';
import { WRITABLE_FIELDS, type ExternalSourceKind, type WritableField } from './catalogOwnership.js';

const DEFAULT_GRAPH_VERSION = 'v23.0';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 15_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // 5000 items: techo del propio items_batch de Meta

/** Campos PÚBLICOS que leemos de Meta para el diff. Nada interno viaja ni vuelve. */
export const REMOTE_ITEM_FIELDS = 'id,retailer_id,name,description,availability,price,currency,image_url,brand,url,condition,product_type';

export interface MetaRemoteCatalogItem {
  /** ID del item en Meta (product item id). */
  id: string;
  retailerId: string;
  name: string;
  description: string;
  availability: string;
  /** Precio formateado por Meta (p.ej. "₲30.000" / "PYG30,000"): comparar solo dígitos. */
  price: string;
  /** Moneda ISO declarada por Meta para el artículo. Vacía si no la expone. */
  currency?: string;
  imageUrl: string;
  brand: string;
  /** URL pública del artículo (identidad de negocio del sitio del tenant). */
  url?: string;
  /** Estado del artículo ("new"). Se lee para poder CONFIRMAR lo que un CREATE mandó. */
  condition?: string;
  /** Taxonomía del artículo ("Perfumes > Perfume > Femenino"): género/tipo sugeridos. */
  productType?: string;
}

/**
 * Request del contrato de ESCRITURA. Se define en `catalogOutbound.ts` (el serializador) y
 * se re-exporta acá por compatibilidad de imports: el cliente solo transporta, no arma.
 */
export type { CatalogBatchRequest } from './catalogOutbound.js';

export interface CatalogBatchItemError {
  retailerId: string;
  message: string;
}

/** Una página del listado remoto (META-CATALOG-GENERIC-ONBOARDING-QUALITY-1). */
export interface MetaCatalogItemsPage {
  items: MetaRemoteCatalogItem[];
  /** Cursor OPACO para pedir la página siguiente. null = no hay más páginas. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Detección de FUENTES EXTERNAS del catálogo (ADR-0015 §4) — metadata SANEADA
// ---------------------------------------------------------------------------

/** Periodicidad declarada por Meta. `UNKNOWN` = vino algo que no reconocemos (no se inventa). */
export type CatalogSourceInterval = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'UNKNOWN';

/** Horario del feed. Es lo único del `schedule` que sobrevive: la URL se descarta entera. */
export interface CatalogSourceSchedule {
  interval: CatalogSourceInterval;
  hour: number | null;
  minute: number | null;
  timezone: string | null;
}

/**
 * Metadata SANEADA de una fuente de datos del catálogo. Es lo ÚNICO que sale del cliente y lo
 * único que se persiste: ni URL firmada, ni query string, ni token, ni nombre de archivo, ni
 * una línea del CSV. Lo que no está acá, no existe para el resto del sistema.
 */
export interface SanitizedCatalogSource {
  /** Todo lo que cuelga de `/product_feeds` es un feed de Meta. El tipo NO se infiere. */
  kind: ExternalSourceKind;
  /** Identificador NO secreto del data source (el que reconoce un humano en la config). */
  sourceId: string;
  /** Nombre humano del feed ya sanitizado (sin URLs, sin blobs opacos). Puede quedar vacío. */
  nombreSaneado: string;
  schedule: CatalogSourceSchedule | null;
  /** SOLO el hostname de la URL del feed (sin esquema, sin path, sin query). null si no hay. */
  host: string | null;
  /** Extensión del archivo (`csv`, `xml`…). Del `file_name` no sobrevive nada más. */
  fileExtension: string | null;
  /** `PRIMARY_FEED` / `SUPPLEMENTARY_FEED` cuando el Graph lo expone. Enum, jamás texto libre. */
  ingestionSourceType: string | null;
  /**
   * Campos públicos que la fuente publica, SOLO si son inferibles de columnas declaradas.
   * Vacío significa "no inferible", NUNCA "no publica nada": la propiedad la declara un humano.
   */
  detectedFields: WritableField[];
  /** Creación del feed en ISO-8601 (un feed recién creado es señal para mirar). */
  createdAt: string | null;
  detectedAt: string;
}

/** Una verificación completa de fuentes externas de un catálogo. */
export interface CatalogSourcesObservation {
  catalogId: string;
  sources: SanitizedCatalogSource[];
  /** `feed_count` que declara el propio catálogo. null = no se pudo corroborar. */
  feedCount: number | null;
  /**
   * false ⇒ el listado PUDO quedar incompleto (paginación topeada, entradas sin id usable o
   * `feed_count` mayor que lo listado). Con esto en false JAMÁS se puede afirmar "no hay
   * fuente nueva": una fuente oculta es exactamente el riesgo que la detección existe para tapar.
   */
  complete: boolean;
  detectedAt: string;
}

/** Campos NO SECRETOS que pedimos de cada data source. */
export const DATA_SOURCE_FIELDS_BASE = 'id,name,file_name,schedule,created_time';
/** No existe en todas las versiones del Graph: si Meta lo rechaza, se reintenta sin él. */
export const DATA_SOURCE_FIELD_INGESTION = 'ingestion_source_type';
/** Un catálogo real tiene un puñado de feeds; más páginas que esto es una anomalía. */
const MAX_SOURCE_PAGES = 5;
const NOMBRE_SANEADO_MAX = 60;

const SOURCE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const INGESTION_TYPE_RE = /^[A-Z][A-Z_]{0,39}$/;
const INTERVALOS: readonly string[] = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];
/** Palabras que jamás deben sobrevivir en una etiqueta humana que vamos a persistir. */
const PALABRA_CREDENCIAL = /\b(?:token|secret|password|passwd|apikey|api_key|signature|hmac|bearer|auth)\b/gi;

/**
 * Nombre del feed listo para persistir. Un humano puede haberlo bautizado pegando la URL
 * firmada entera, así que se limpia en capas: URLs, restos de query string, blobs opacos
 * (un token es una tirada larga sin espacios), palabras de credencial y por último una
 * whitelist de caracteres de etiqueta. Lo que queda es texto humano o nada.
 */
export function sanitizeSourceName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
    .replace(/[?&]\S*/g, ' ')
    .replace(/[A-Za-z0-9_-]{24,}/g, ' ')
    .replace(PALABRA_CREDENCIAL, ' ')
    .replace(/[^\p{L}\p{N} .,()_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOMBRE_SANEADO_MAX)
    .trim();
}

/**
 * De la URL del feed sobrevive SOLO el hostname. El query string lleva el token (es el caso
 * real que motivó el ADR) pero el path también puede llevarlo (`/feeds/<firma>/products.csv`),
 * así que no se conserva ni el path ni el puerto ni el userinfo: nada salvo el host.
 */
export function hostFromFeedUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function enteroEnRango(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Horario + host del `schedule` crudo. Meta manda hora y minuto como strings ("3", "33"). */
export function sanitizeSourceSchedule(raw: unknown): { schedule: CatalogSourceSchedule | null; host: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schedule: null, host: null };
  const r = raw as Record<string, unknown>;
  const iv = typeof r.interval === 'string' ? r.interval.trim().toUpperCase() : '';
  const tz = typeof r.timezone === 'string' ? r.timezone.trim() : '';
  return {
    schedule: {
      interval: (INTERVALOS.includes(iv) ? iv : 'UNKNOWN') as CatalogSourceInterval,
      hour: enteroEnRango(r.hour, 0, 23),
      minute: enteroEnRango(r.minute, 0, 59),
      timezone: tz.length <= 64 && TIMEZONE_RE.test(tz) ? tz : null,
    },
    host: hostFromFeedUrl(r.url),
  };
}

/**
 * Columnas típicas de un feed → campo público del contrato. Solo se usa cuando la fuente
 * DECLARA sus columnas; jamás se abre el archivo para averiguarlas.
 */
const COLUMNA_A_CAMPO: Readonly<Record<string, WritableField>> = {
  title: 'title',
  name: 'title',
  description: 'description',
  price: 'price',
  sale_price: 'price',
  currency: 'currency',
  availability: 'availability',
  inventory: 'inventory',
  quantity_to_sell_on_facebook: 'inventory',
  brand: 'brand',
  google_product_category: 'category',
  fb_product_category: 'category',
  product_type: 'category',
  image_link: 'image',
  additional_image_link: 'image',
  link: 'url',
};

/** Campos públicos inferibles de las columnas declaradas. Orden canónico de WRITABLE_FIELDS. */
export function inferFieldsFromColumns(raw: unknown): WritableField[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<WritableField>();
  for (const c of raw) {
    if (typeof c !== 'string') continue;
    const campo = COLUMNA_A_CAMPO[c.trim().toLowerCase()];
    if (campo) out.add(campo);
  }
  return WRITABLE_FIELDS.filter((f) => out.has(f));
}

/** Del `file_name` solo sobrevive la extensión: el resto sale del último tramo de la URL. */
function extensionDeArchivo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const ext = /\.([A-Za-z0-9]{1,8})(?:$|[?#])/.exec(raw.trim())?.[1];
  return ext ? ext.toLowerCase() : null;
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const PATRON_ESQUEMA = /:\/\//;
const PATRON_QUERY = /[?&][A-Za-z0-9_.-]+=/;

/**
 * ÚLTIMA BARRERA antes de devolver o persistir metadata de una fuente: mismo espíritu que
 * `assertItemsBatchBody`, que corre igual en el cliente real y en el fake. Si una regresión
 * futura dejara pasar un esquema de URL, un query string o una palabra de credencial, esto
 * lanza en vez de escribirlo en Firestore. No debería poder dispararse: es un guard de bug.
 */
export function assertSanitizedSource(s: SanitizedCatalogSource): void {
  const textos = [s.sourceId, s.nombreSaneado, s.host ?? '', s.fileExtension ?? '', s.ingestionSourceType ?? '', s.schedule?.timezone ?? '', s.createdAt ?? ''];
  for (const t of textos) {
    if (PATRON_ESQUEMA.test(t) || PATRON_QUERY.test(t)) {
      throw new MetaCatalogApiError('Detección de fuentes: metadata sin sanear (URL o query string); se aborta antes de devolverla.', 'http', null, null, false);
    }
  }
  PALABRA_CREDENCIAL.lastIndex = 0; // el flag /g mantiene estado entre llamadas
  if (PALABRA_CREDENCIAL.test(s.nombreSaneado)) {
    throw new MetaCatalogApiError('Detección de fuentes: el nombre saneado menciona una credencial; se aborta antes de devolverlo.', 'http', null, null, false);
  }
}

/**
 * Data source crudo del Graph → metadata saneada. Devuelve null si la entrada no tiene un
 * identificador usable: sin id no hay fuente que un humano pueda reconocer, y contarla como
 * "ninguna fuente" sería mentir — por eso el llamador la trata como listado INCOMPLETO.
 */
export function sanitizeDataSource(raw: unknown, detectedAt: string): SanitizedCatalogSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sourceId = typeof r.id === 'string' ? r.id.trim() : typeof r.id === 'number' ? String(r.id) : '';
  if (!SOURCE_ID_RE.test(sourceId)) return null;
  // `update_schedule` es el hermano incremental de `schedule`: si el catálogo usa ese, el
  // horario real está ahí. Se lee de forma defensiva aunque no lo pidamos explícitamente.
  const { schedule, host } = sanitizeSourceSchedule(r.schedule ?? r.update_schedule);
  const ingestion = typeof r.ingestion_source_type === 'string' ? r.ingestion_source_type.trim().toUpperCase() : '';
  const saneada: SanitizedCatalogSource = {
    kind: 'meta_feed',
    sourceId,
    nombreSaneado: sanitizeSourceName(r.name),
    schedule,
    host,
    fileExtension: extensionDeArchivo(r.file_name),
    ingestionSourceType: INGESTION_TYPE_RE.test(ingestion) ? ingestion : null,
    detectedFields: inferFieldsFromColumns(r.columns),
    createdAt: isoOrNull(r.created_time),
    detectedAt,
  };
  assertSanitizedSource(saneada);
  return saneada;
}

export interface MetaCatalogClient {
  /**
   * Llamadas HTTP realizadas a Meta desde que se creó el cliente. Cuenta CADA request, no cada
   * método: `listItems` de un catálogo grande consume una llamada por página. Es lo que
   * permite acotar de verdad el consumo de una corrida del outbox.
   */
  readonly callsMade: number;
  /** Metadatos del catálogo (lanza MetaCatalogApiError si no existe o no hay permiso). */
  getCatalog(catalogId: string): Promise<{ id: string; name: string }>;
  /** Lista COMPLETA (paginada) de items del catálogo. Lanza si supera el tope soportado. */
  listItems(catalogId: string): Promise<MetaRemoteCatalogItem[]>;
  /**
   * UNA página del listado (importación paginada/reanudable). Sin cursor arranca desde el
   * principio; con cursor sigue desde donde quedó. Un cursor vencido o adulterado lanza
   * `invalid_cursor` (clasificable con `isInvalidCatalogCursor`): el llamador reinicia el
   * barrido — la idempotencia por docId hace seguro re-escanear. `listItems` queda INTACTO
   * y fail-closed para el plan/preview/outbox (un diff con listado parcial mentiría).
   */
  listItemsPage(catalogId: string, cursor?: string | null): Promise<MetaCatalogItemsPage>;
  /**
   * Lista las FUENTES DE DATOS del catálogo (`/product_feeds`) devolviendo SOLO metadata
   * saneada (ADR-0015 §4). Es una lectura: jamás desactiva ni modifica un feed. La URL firmada
   * del schedule NO se devuelve — de ella queda únicamente el hostname.
   */
  listDataSources(catalogId: string): Promise<CatalogSourcesObservation>;
  /** Envía un lote de escrituras ya serializadas. JAMÁS borra items. */
  submitItemsBatch(catalogId: string, requests: CatalogBatchRequest[]): Promise<{ handles: string[] }>;
  /** Estado best-effort de un batch asíncrono (errores por item si Meta ya los reportó). */
  getBatchStatus(catalogId: string, handle: string): Promise<{ errors: CatalogBatchItemError[] }>;
}

/** Error estructurado y SANEADO (jamás incluye el token). */
export class MetaCatalogApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'missing_token' | 'http' | 'invalid_cursor',
    readonly status: number | null = null,
    readonly fbCode: number | null = null,
    readonly retriable = false,
  ) {
    super(message);
    this.name = 'MetaCatalogApiError';
  }
}

/** true si el error es un cursor de paginación vencido/inválido (⇒ reiniciar el barrido). */
export const isInvalidCatalogCursor = (e: unknown): boolean =>
  e instanceof MetaCatalogApiError && e.kind === 'invalid_cursor';

const maskId = (id: string) => (id.length > 4 ? `…${id.slice(-4)}` : '…');

/**
 * Mapeo ÚNICO del item crudo (snake_case del contrato de lectura) al modelo camelCase.
 * Lo comparten `listItems`, `listItemsPage` y el fake: dos mapeos se desincronizan.
 */
function toRemoteItem(raw: Record<string, unknown>): MetaRemoteCatalogItem {
  return {
    id: String(raw.id ?? ''),
    retailerId: String(raw.retailer_id ?? ''),
    name: String(raw.name ?? ''),
    description: String(raw.description ?? ''),
    availability: String(raw.availability ?? ''),
    price: String(raw.price ?? ''),
    currency: String(raw.currency ?? ''),
    imageUrl: String(raw.image_url ?? ''),
    brand: String(raw.brand ?? ''),
    url: String(raw.url ?? ''),
    condition: String(raw.condition ?? ''),
    productType: String(raw.product_type ?? ''),
  };
}

/** Solo un cursor del propio Graph API puede seguirse con el Bearer puesto. */
const GRAPH_CURSOR_PREFIX = 'https://graph.facebook.com/';

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
  /** Requests HTTP efectivamente emitidos (incluye reintentos y cada página de `listItems`). */
  private llamadas = 0;
  get callsMade(): number {
    return this.llamadas;
  }

  /** Reloj inyectable: `detectedAt` de la detección de fuentes tiene que ser determinístico. */
  private readonly now: () => string;

  constructor(
    private readonly accessToken: string,
    opts?: { version?: string; transport?: CatalogTransport; sleep?: (ms: number) => Promise<void>; now?: () => string },
  ) {
    const version = opts?.version ?? process.env.META_CATALOG_GRAPH_VERSION ?? DEFAULT_GRAPH_VERSION;
    this.base = `https://graph.facebook.com/${version}`;
    this.transport = opts?.transport ?? axiosTransport;
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  /**
   * GET/POST con retry 429/5xx/red (backoff + Retry-After). El token NUNCA sale en logs/errores.
   *
   * ⚠️ EL POST NO SE REINTENTA. Un GET es idempotente y reintentarlo no tiene consecuencias,
   * pero un `items_batch` que sufrió un timeout PUDO haber sido aceptado por Meta: repetirlo
   * acá sería exactamente el "reintento a ciegas" que el outbox tiene prohibido, y lo haría
   * DEBAJO de su disciplina de ambigüedad, sin que quedara registro. El outbox recibe el error
   * ambiguo, mira el catálogo real y recién ahí decide (ADR-0013 §7).
   */
  private async request(method: 'GET' | 'POST', url: string, data?: unknown): Promise<unknown> {
    let lastMsg = 'error de red';
    let lastStatus: number | null = null;
    let lastCode: number | null = null;
    const maxAttempts = method === 'GET' ? MAX_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: CatalogHttpResponse | null = null;
      this.llamadas++;
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
      if (attempt < maxAttempts) {
        const wait = retryAfterMs(res?.headers ?? {}, attempt);
        logger.warn('Meta Catalog API reintentando', { status: lastStatus, attempt, waitMs: wait });
        await this.sleep(wait);
      }
    }
    const prefijo = method === 'GET' ? 'agotó reintentos' : 'no pudo confirmar el resultado';
    throw new MetaCatalogApiError(`Meta Catalog API ${prefijo} (${lastStatus ?? 'red'}): ${lastMsg}`, 'http', lastStatus, lastCode, true);
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
      for (const raw of data.data ?? []) items.push(toRemoteItem(raw));
      const next = data.paging?.next ?? null; // paging.next NO trae el token (va por header)
      if (next && !next.startsWith(GRAPH_CURSOR_PREFIX)) {
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

  /**
   * UNA página por llamada (importación paginada). Mismo request, mapeo y validación de host
   * que `listItems` — el cursor es la URL `paging.next` COMPLETA que devolvió Meta (no trae
   * el token: la autorización viaja por header). Se valida también al RECIBIRLA como input:
   * un cursor persistido/adulterado con otro host jamás se sigue con el Bearer puesto.
   */
  async listItemsPage(catalogId: string, cursor?: string | null): Promise<MetaCatalogItemsPage> {
    let url = `${this.base}/${catalogId}/products?fields=${REMOTE_ITEM_FIELDS}&limit=${PAGE_LIMIT}`;
    if (cursor != null && cursor !== '') {
      if (!cursor.startsWith(GRAPH_CURSOR_PREFIX)) {
        throw new MetaCatalogApiError('Meta Catalog: cursor de paginación con host inesperado; se reinicia el barrido.', 'invalid_cursor', null, null, false);
      }
      url = cursor;
    }
    let data: { data?: Array<Record<string, unknown>>; paging?: { next?: string } };
    try {
      data = ((await this.request('GET', url)) ?? {}) as typeof data;
    } catch (e) {
      // Graph responde 400 code 100 cuando el cursor venció o no es válido. SOLO se
      // clasifica así cuando efectivamente seguíamos un cursor: el mismo error en la
      // primera página es un problema real del catálogo y debe propagarse tal cual.
      if (cursor && e instanceof MetaCatalogApiError && e.status === 400 && e.fbCode === 100) {
        throw new MetaCatalogApiError(`Meta Catalog: cursor de paginación vencido o inválido (${e.message.slice(0, 120)})`, 'invalid_cursor', 400, 100, false);
      }
      throw e;
    }
    const next = data.paging?.next ?? null;
    if (next && !next.startsWith(GRAPH_CURSOR_PREFIX)) {
      throw new MetaCatalogApiError('Meta Catalog: cursor de paginación con host inesperado; corrida abortada.', 'http', null, null, false);
    }
    return { items: (data.data ?? []).map(toRemoteItem), nextCursor: next };
  }

  /** Una página de `/product_feeds`, con la misma validación de host que el resto del cliente. */
  private async getFeedsPage(url: string): Promise<{ data?: Array<Record<string, unknown>>; paging?: { next?: string } }> {
    const data = ((await this.request('GET', url)) ?? {}) as { data?: Array<Record<string, unknown>>; paging?: { next?: string } };
    const next = data.paging?.next;
    if (next && !next.startsWith(GRAPH_CURSOR_PREFIX)) {
      throw new MetaCatalogApiError('Meta Catalog: cursor de fuentes con host inesperado; detección abortada.', 'http', null, null, false);
    }
    return data;
  }

  /**
   * `feed_count` del propio catálogo: corrobora que el listado no quedó corto. Es una
   * comprobación OPCIONAL — si el Graph no la expone o falla, la detección igual vale; lo que
   * no puede pasar es que un conteo MAYOR al listado se lea como "no hay fuentes nuevas".
   */
  private async feedCount(catalogId: string): Promise<number | null> {
    try {
      const d = ((await this.request('GET', `${this.base}/${catalogId}?fields=feed_count`)) ?? {}) as { feed_count?: unknown };
      const n = typeof d.feed_count === 'number' ? d.feed_count : Number(d.feed_count);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  async listDataSources(catalogId: string): Promise<CatalogSourcesObservation> {
    const detectedAt = this.now();
    const base = `${this.base}/${catalogId}/product_feeds?limit=${PAGE_LIMIT}&fields=`;
    let data: { data?: Array<Record<string, unknown>>; paging?: { next?: string } };
    try {
      data = await this.getFeedsPage(`${base}${DATA_SOURCE_FIELDS_BASE},${DATA_SOURCE_FIELD_INGESTION}`);
    } catch (e) {
      // `ingestion_source_type` no existe en todas las versiones del Graph y un campo
      // desconocido se rechaza con 400/code 100. Se reintenta UNA vez con el set base: si el
      // problema era otro (catálogo inexistente, permiso), el segundo GET vuelve a fallar.
      if (!(e instanceof MetaCatalogApiError && e.status === 400 && e.fbCode === 100)) throw e;
      data = await this.getFeedsPage(`${base}${DATA_SOURCE_FIELDS_BASE}`);
    }
    const sources: SanitizedCatalogSource[] = [];
    let inutilizables = 0;
    let paginas = 0;
    let next: string | null = null;
    for (;;) {
      for (const raw of data.data ?? []) {
        const s = sanitizeDataSource(raw, detectedAt);
        if (s) sources.push(s);
        else inutilizables++;
      }
      next = data.paging?.next ?? null;
      paginas++;
      if (!next || paginas >= MAX_SOURCE_PAGES) break;
      data = await this.getFeedsPage(next);
    }
    const feedCount = await this.feedCount(catalogId);
    // FAIL-CLOSED de la detección: si quedaron páginas sin leer, entradas sin id usable o el
    // catálogo declara más feeds de los que listamos, el resultado NO habilita a concluir que
    // no hay fuente nueva. Se reporta incompleto y el comparador lo trata como tal.
    const complete = !next && inutilizables === 0 && (feedCount === null || feedCount <= sources.length);
    return { catalogId, sources, feedCount, complete, detectedAt };
  }

  async submitItemsBatch(catalogId: string, requests: CatalogBatchRequest[]): Promise<{ handles: string[] }> {
    const body = {
      item_type: ITEMS_BATCH_ITEM_TYPE,
      // EXPLÍCITO: el default de Meta es true (un UPDATE crearía el item si no existe).
      // Apagarlo obliga a que crear sea una decisión declarada (`method: 'CREATE'`).
      allow_upsert: ITEMS_BATCH_ALLOW_UPSERT,
      requests,
    };
    // ÚLTIMA BARRERA ANTES DE LA RED: el mismo validador que usa el fake corre también acá.
    // Si una regresión (o un cast) armara un request fuera del contrato —un DELETE, un campo
    // interno, una identidad de más de 100 caracteres—, no llega a salir.
    assertItemsBatchBody(body);
    const data = ((await this.request('POST', `${this.base}/${catalogId}/items_batch`, body)) ?? {}) as { handles?: unknown[] };
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
  /**
   * `when` distingue los DOS momentos en que puede fallar un batch, que producen consecuencias
   * opuestas y hasta ahora eran indistinguibles:
   *  - `before_accept` (default): Meta rechazó la llamada. NADA se escribió.
   *  - `after_accept`: Meta ACEPTÓ y procesó, pero el cliente vio un timeout. El escrito
   *    EXISTE aunque el llamador no lo sepa. Es el caso que obliga a mirar antes de reintentar.
   */
  failWith?: { op: 'getCatalog' | 'listItems' | 'batch' | 'batchStatus' | 'listDataSources'; status?: number; code?: number; message?: string; when?: 'before_accept' | 'after_accept' };
  /**
   * Data sources CRUDOS (forma del Graph, con URL firmada y todo) para el E2E de detección:
   * permite simular 0 feeds, 1 feed, un feed NUEVO y un feed con el schedule cambiado sin
   * tocar la red. El fake los sanea con la MISMA función que el cliente real, así que el
   * emulador ejercita también la barrera de saneamiento.
   */
  dataSources?: Array<Record<string, unknown>>;
  /** `feed_count` que declara el catálogo: mayor que `dataSources` ⇒ listado INCOMPLETO. */
  feedCount?: number;
  /** Reloj del fixture: fija `detectedAt` para que el E2E sea determinístico. */
  dataSourcesDetectedAt?: string;
  /**
   * Con esto en true el fake APLICA el batch sobre `items` (como haría Meta), normalizando la
   * URL igual que Meta. Sin esto, el camino "enviado → confirmado" no se puede ejercitar: la
   * relectura devolvería siempre el estado viejo.
   */
  applyBatchToFixture?: boolean;
  /** Estado por handle: `queued`/`in_progress` = Meta todavía no terminó de procesar. */
  batchStatus?: Record<string, { status?: string; errors?: Array<{ retailer_id?: string; message?: string }> }>;
  /** Páginas que "cuesta" un `listItems` (el cliente real gasta una llamada por página). */
  pagesPerList?: number;
}

/**
 * WHITELIST de campos admitidos dentro de `data` en un request de escritura. Es whitelist y
 * no blacklist a propósito: si una regresión futura intentara enviar un campo interno
 * (costo, margen, notas), el fake lo rechaza en vez de aceptarlo y persistirlo.
 */
const WRITE_ALLOWED_FIELDS = new Set(['id', 'title', 'description', 'link', 'price', 'availability', 'condition', 'brand', 'image']);
/** Campos del contrato de LECTURA: se nombran aparte para dar un error explicativo. */
const READ_ONLY_FIELD_NAMES = ['name', 'image_url', 'url', 'retailer_id'];
/** Obligatorios de un CREATE de PRODUCT_ITEM (contrato v23). */
const CREATE_REQUIRED = ['id', 'title', 'description', 'link', 'price', 'availability', 'condition', 'brand', 'image'];

/**
 * Valida que un request cumpla el contrato de escritura de `items_batch`. Lanza con un
 * mensaje explícito ante cualquier desvío — así el E2E falla igual que fallaría Meta.
 */
/** Máximo de requests por llamada según el contrato (recomendado por Meta: 3000). */
const MAX_REQUESTS_PER_BATCH = 5000;

/**
 * Valida el BODY completo de `items_batch` antes de enviarlo: `item_type`, el
 * `allow_upsert` explícito, el tamaño del lote y cada request. Corre tanto en el cliente
 * HTTP real como en el fake, así que el emulador ejercita exactamente la misma barrera.
 */
export function assertItemsBatchBody(body: unknown): void {
  const b = body as { item_type?: unknown; allow_upsert?: unknown; requests?: unknown };
  if (b?.item_type !== ITEMS_BATCH_ITEM_TYPE) {
    throw new MetaCatalogApiError(`items_batch: item_type debe ser "${ITEMS_BATCH_ITEM_TYPE}"`, 'http', 400, 100, false);
  }
  if (b?.allow_upsert !== ITEMS_BATCH_ALLOW_UPSERT) {
    throw new MetaCatalogApiError('items_batch: allow_upsert debe declararse explícitamente en false (crear es una decisión del planner)', 'http', 400, 100, false);
  }
  if (!Array.isArray(b?.requests) || b.requests.length === 0) {
    throw new MetaCatalogApiError('items_batch: requests vacío', 'http', 400, 100, false);
  }
  if (b.requests.length > MAX_REQUESTS_PER_BATCH) {
    throw new MetaCatalogApiError(`items_batch: el lote supera el límite de ${MAX_REQUESTS_PER_BATCH} requests`, 'http', 400, 100, false);
  }
  for (const [i, r] of b.requests.entries()) assertBatchRequestShape(r, `requests[${i}]`);
}

export function assertBatchRequestShape(r: unknown, where = 'request'): void {
  const req = r as { method?: unknown; data?: unknown } & Record<string, unknown>;
  if (!req || typeof req !== 'object') throw new MetaCatalogApiError(`${where}: request inválido`, 'http', 400, 100, false);
  if (req.method !== 'CREATE' && req.method !== 'UPDATE') {
    // DELETE es parte del contrato de Meta pero NINGÚN builder lo emite: el borrado físico
    // será una operación aparte con confirmación humana. Rechazarlo acá convierte el
    // invariante "jamás se borra" en una barrera ejecutable, no solo un comentario.
    throw new MetaCatalogApiError(`${where}: method "${String(req.method)}" no permitido (solo CREATE|UPDATE; el borrado es una operación aparte)`, 'http', 400, 100, false);
  }
  // La identidad va DENTRO de data. Un `retailer_id` hermano es el contrato equivocado.
  for (const ajeno of Object.keys(req)) {
    if (ajeno !== 'method' && ajeno !== 'data') {
      throw new MetaCatalogApiError(`${where}: campo "${ajeno}" fuera de data — la identidad va en data.id`, 'http', 400, 100, false);
    }
  }
  const data = req.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') throw new MetaCatalogApiError(`${where}: falta data`, 'http', 400, 100, false);
  if (typeof data.id !== 'string' || !data.id.trim()) {
    throw new MetaCatalogApiError(`${where}: falta data.id (identidad del artículo)`, 'http', 400, 100, false);
  }
  if (String(data.id).length > MAX_ID_LENGTH) {
    throw new MetaCatalogApiError(`${where}: data.id supera los ${MAX_ID_LENGTH} caracteres`, 'http', 400, 100, false);
  }
  for (const campo of Object.keys(data)) {
    if (WRITE_ALLOWED_FIELDS.has(campo)) continue;
    if (READ_ONLY_FIELD_NAMES.includes(campo)) {
      throw new MetaCatalogApiError(`${where}: "${campo}" pertenece al contrato de LECTURA; el de escritura usa title/image/link`, 'http', 400, 100, false);
    }
    throw new MetaCatalogApiError(`${where}: campo "${campo}" no pertenece al contrato de escritura de PRODUCT_ITEM`, 'http', 400, 100, false);
  }
  if (req.method === 'CREATE') {
    const faltan = CREATE_REQUIRED.filter((f) => data[f] === undefined || data[f] === '' || (Array.isArray(data[f]) && !(data[f] as unknown[]).length));
    if (faltan.length) throw new MetaCatalogApiError(`${where}: CREATE sin campos obligatorios: ${faltan.join(', ')}`, 'http', 400, 100, false);
  }
  // `image` siempre debe ser el array del contrato de escritura, también en un UPDATE.
  if (data.image !== undefined) {
    const img = data.image;
    if (!Array.isArray(img) || !img.length || !img.every((i) => !!(i as { url?: unknown })?.url)) {
      throw new MetaCatalogApiError(`${where}: image debe ser un array no vacío de objetos { url }`, 'http', 400, 100, false);
    }
  }
  if (data.price !== undefined && !/^\d+ [A-Z]{3}$/.test(String(data.price))) {
    throw new MetaCatalogApiError(`${where}: price debe ser "<monto> <ISO>" (p.ej. "250000 PYG")`, 'http', 400, 100, false);
  }
  // Mismo predicado que usa el serializador: validar con dos criterios distintos hacía que
  // un valor aceptado al construir (p.ej. "HTTPS://x") explotara recién en el transporte.
  if (data.link !== undefined && canonicalHttpsUrl(data.link) !== String(data.link)) {
    throw new MetaCatalogApiError(`${where}: link debe ser una URL https en forma canónica`, 'http', 400, 100, false);
  }
  if (data.title !== undefined && String(data.title).length > 100) {
    throw new MetaCatalogApiError(`${where}: title supera los 100 caracteres`, 'http', 400, 100, false);
  }
  if (data.availability !== undefined && data.availability !== 'in stock' && data.availability !== 'out of stock') {
    throw new MetaCatalogApiError(`${where}: availability inválida "${String(data.availability)}"`, 'http', 400, 100, false);
  }
  if (data.condition !== undefined && !['new', 'refurbished', 'used'].includes(String(data.condition))) {
    throw new MetaCatalogApiError(`${where}: condition inválida "${String(data.condition)}"`, 'http', 400, 100, false);
  }
}

export class FakeMetaCatalogClient implements MetaCatalogClient {
  constructor(private readonly seed: CatalogFixture) {}

  /** Mismo contador que el cliente real: el E2E puede afirmar cuántas llamadas costó una corrida. */
  private llamadas = 0;
  get callsMade(): number {
    return this.llamadas;
  }

  /**
   * El fixture se RELEE en cada llamada. Congelarlo en el constructor hacía imposible el caso
   * central de un outbox asíncrono: mutar el estado remoto entre el envío y la relectura.
   */
  private async fixture(): Promise<CatalogFixture> {
    try {
      const fresh = (await db().doc('metaTestFixtures/catalog').get()).data() as CatalogFixture | undefined;
      return fresh ?? this.seed;
    } catch {
      return this.seed;
    }
  }

  private failIf(fx: CatalogFixture, op: 'getCatalog' | 'listItems' | 'batch' | 'batchStatus' | 'listDataSources', when: 'before_accept' | 'after_accept' = 'before_accept'): void {
    const f = fx.failWith;
    if (f?.op === op && (f.when ?? 'before_accept') === when) {
      const status = f.status ?? 400;
      throw new MetaCatalogApiError(`Meta Catalog API ${status} (code ${f.code ?? 100}): ${f.message ?? 'fixture error'}`, 'http', status, f.code ?? 100, status === 429 || status >= 500);
    }
  }

  async getCatalog(catalogId: string): Promise<{ id: string; name: string }> {
    const fx = await this.fixture();
    this.llamadas++;
    this.failIf(fx, 'getCatalog');
    const cat = fx.catalog;
    if (!cat || cat.id !== catalogId) {
      throw new MetaCatalogApiError(`Meta Catalog API 400 (code 100): Unsupported get request (${maskId(catalogId)})`, 'http', 400, 100, false);
    }
    return { id: cat.id, name: cat.name };
  }

  async listItems(_catalogId: string): Promise<MetaRemoteCatalogItem[]> {
    const fx = await this.fixture();
    // Una llamada por PÁGINA, igual que el cliente real: un catálogo grande no cuesta "una
    // llamada" y el presupuesto de la corrida tiene que verlo.
    this.llamadas += Math.max(1, fx.pagesPerList ?? 1);
    this.failIf(fx, 'listItems');
    return (fx.items ?? []).map(toRemoteItem);
  }

  /**
   * Paginación REAL del fixture: `pagesPerList` divide `items` en páginas determinísticas y
   * el cursor sintético es `page:<n>` (índice de la PRÓXIMA página). Un cursor malformado o
   * fuera de rango lanza `invalid_cursor`, igual que un cursor de Graph vencido — es lo que
   * permite ejercitar el reset del barrido en el emulador. `failWith` de `listItems` aplica
   * también acá (fallo a mitad de importación con cursor ya persistido).
   */
  async listItemsPage(_catalogId: string, cursor?: string | null): Promise<MetaCatalogItemsPage> {
    const fx = await this.fixture();
    this.llamadas++; // una llamada por página, como el cliente real
    this.failIf(fx, 'listItems');
    const all = (fx.items ?? []).map(toRemoteItem);
    const pages = Math.max(1, Math.trunc(fx.pagesPerList ?? 1));
    const pageSize = Math.max(1, Math.ceil(all.length / pages));
    let pageIndex = 0;
    if (cursor != null && cursor !== '') {
      const m = /^page:(\d+)$/.exec(cursor);
      const n = m ? Number(m[1]) : NaN;
      const fueraDeRango = !Number.isInteger(n) || n < 1 || n * pageSize >= Math.max(all.length, 1);
      if (!m || fueraDeRango) {
        throw new MetaCatalogApiError('Meta Catalog: cursor de paginación vencido o inválido (fixture).', 'invalid_cursor', 400, 100, false);
      }
      pageIndex = n;
    }
    const start = pageIndex * pageSize;
    const items = all.slice(start, start + pageSize);
    const nextCursor = start + pageSize < all.length ? `page:${pageIndex + 1}` : null;
    return { items, nextCursor };
  }

  /**
   * Detección de fuentes contra el fixture. Sanea con la MISMA función que el cliente real —
   * dos saneadores distintos se desincronizan y uno de los dos termina filtrando el token.
   */
  async listDataSources(catalogId: string): Promise<CatalogSourcesObservation> {
    const fx = await this.fixture();
    // Una llamada por el listado + una por `feed_count`, igual que el cliente real.
    this.llamadas += 2;
    this.failIf(fx, 'listDataSources');
    const detectedAt = fx.dataSourcesDetectedAt ?? new Date().toISOString();
    const sources: SanitizedCatalogSource[] = [];
    let inutilizables = 0;
    for (const raw of fx.dataSources ?? []) {
      const s = sanitizeDataSource(raw, detectedAt);
      if (s) sources.push(s);
      else inutilizables++;
    }
    const feedCount = typeof fx.feedCount === 'number' ? fx.feedCount : (fx.dataSources ?? []).length;
    const complete = inutilizables === 0 && feedCount <= sources.length;
    return { catalogId, sources, feedCount, complete, detectedAt };
  }

  async submitItemsBatch(catalogId: string, requests: CatalogBatchRequest[]): Promise<{ handles: string[] }> {
    const fx = await this.fixture();
    this.llamadas++;
    // Falla ANTES de aceptar: Meta rechazó la llamada y no escribió nada.
    this.failIf(fx, 'batch', 'before_accept');
    // VALIDACIÓN ESTRICTA DEL CONTRATO: el fake anterior aceptaba cualquier forma y por eso
    // no detectó que el serializador mandaba `name`/`image_url` y la identidad fuera de
    // `data`. Ahora arma el MISMO body que el cliente real y lo valida entero, así el E2E
    // del emulador ejercita también las invariantes de nivel body (item_type, allow_upsert,
    // tamaño del lote) y no solo la forma de cada request.
    assertItemsBatchBody({ item_type: ITEMS_BATCH_ITEM_TYPE, allow_upsert: ITEMS_BATCH_ALLOW_UPSERT, requests });
    await db().collection('metaTestFixtures/catalog/writes').add({
      catalogId,
      requestCount: requests.length,
      requests: requests.map((r) => ({ method: r.method, data: r.data })),
      at: Timestamp.now(),
    });
    if (fx.applyBatchToFixture) await this.applyBatch(fx, requests);
    // Falla DESPUÉS de aceptar: el escrito ya existe del lado de Meta y el llamador ve un
    // timeout. Sin este caso, el camino ambiguo no se puede testear.
    this.failIf(fx, 'batch', 'after_accept');
    // Meta devuelve UN handle por batch, no uno por request.
    return { handles: fx.batchHandles ?? [`fx-handle-${Date.now().toString(36)}`] };
  }

  /** Aplica el batch sobre `items`, normalizando la URL igual que lo hace Meta. */
  private async applyBatch(fx: CatalogFixture, requests: CatalogBatchRequest[]): Promise<void> {
    const items = [...(fx.items ?? [])];
    for (const r of requests) {
      const data = r.data as Record<string, unknown>;
      const rid = String(data.id ?? '');
      const i = items.findIndex((it) => String(it.retailer_id ?? '') === rid);
      const parche: Record<string, unknown> = {};
      if (data.title !== undefined) parche.name = data.title;
      if (data.description !== undefined) parche.description = data.description;
      if (data.price !== undefined) parche.price = String(data.price).replace(/\s*[A-Z]{3}$/, '');
      if (data.availability !== undefined) parche.availability = data.availability;
      if (data.brand !== undefined) parche.brand = data.brand;
      if (data.condition !== undefined) parche.condition = data.condition;
      if (data.link !== undefined) {
        // Meta NORMALIZA lo que recibe: host en minúsculas y barra final. Que el fake lo haga
        // es lo que prueba que la comparación tolera la normalización.
        try {
          parche.url = new URL(String(data.link)).href;
        } catch {
          parche.url = String(data.link);
        }
      }
      if (Array.isArray(data.image)) parche.image_url = String((data.image[0] as { url?: unknown })?.url ?? '');
      if (i >= 0) items[i] = { ...items[i], ...parche };
      else if (r.method === 'CREATE') items.push({ id: `itm-${rid}`, retailer_id: rid, ...parche });
    }
    await db().doc('metaTestFixtures/catalog').set({ items }, { merge: true });
  }

  async getBatchStatus(_catalogId: string, handle: string): Promise<{ errors: CatalogBatchItemError[] }> {
    const fx = await this.fixture();
    this.llamadas++;
    this.failIf(fx, 'batchStatus');
    const porHandle = fx.batchStatus?.[handle];
    const errores = porHandle?.errors ?? fx.batchStatusErrors ?? [];
    return {
      errors: errores.map((e) => ({
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
