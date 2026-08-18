/**
 * lib/catalogAuthority.ts — Autoridad de catálogo autoservicio (ADR-0022), lado panel.
 *
 * QUIÉN administra el catálogo (VendeYaPy / Meta / otro sistema) y QUÉ relación tiene con
 * Meta (`none` solo bot · `mirror` espejo de lectura · `managed` publicación). Acá viven:
 *  - la normalización tolerante del eje `authority` que agrega `metaCatalogOwnershipStatus`;
 *  - los wrappers de los callables nuevos `metaCatalogAuthorityPreview` / `...Apply`
 *    (OWNER/PLATFORM_ADMIN; el backend los implementa en paralelo con ESTOS nombres);
 *  - la traducción a criollo de bloqueos del preview y kinds del apply (ids cerrados);
 *  - los helpers PUROS de frescura del espejo (§5) y de gating por relación (§4).
 *
 * FAIL-CLOSED: si el backend todavía no manda `authority` (contrato viejo), la vista es null
 * y el panel NO cambia el comportamiento vigente ni ofrece el cambio de modo. Todo texto que
 * llega del backend pasa por el saneador de ADR-0015 antes de pintarse (jamás URLs, query
 * strings ni tokens).
 */

import { httpsCallable } from 'firebase/functions';
import type { Product } from '@vpw/shared';
import { firebaseFunctions } from './firebase';
import {
  CAMPOS_PUBLICOS,
  etiquetaTipoFuente,
  sanitizarTextoPublico,
  type CampoPublico,
} from './catalogOwnership';
import type { CatalogOwnershipStatus, ProductInput } from './catalog';

// --- Contrato canónico (ADR-0022 §1) -----------------------------------------

export type AutoridadCatalogo = 'vendeyapy' | 'meta' | 'external';
export type RelacionCatalogo = 'none' | 'mirror' | 'managed';

/** Destino de un cambio de modo, con los nombres EXACTOS del contrato del backend. */
export interface AuthorityTarget {
  authority: AutoridadCatalogo;
  relationship: RelacionCatalogo;
}

/** Vista normalizada del eje `authority` del status. */
export interface CatalogAuthorityView {
  autoridad: AutoridadCatalogo;
  relacion: RelacionCatalogo;
  /** true = la relación fue elegida por una persona; false = derivada de la config legacy. */
  declarada: boolean;
  /** Motivos crudos de la derivación/degradación (se traducen antes de pintar). */
  motivos: string[];
  /** Frescura (§5): evidencia real de lecturas — jamás se dice «verificado» sin esto. */
  frescura: {
    verificadoEn: Date | null;
    fuenteLeidaEn: Date | null;
    importadoEn: Date | null;
  };
}

const AUTORIDADES: readonly string[] = ['vendeyapy', 'meta', 'external'];
const RELACIONES: readonly string[] = ['none', 'mirror', 'managed'];

/**
 * Fecha tolerante para el contrato de `staleness` (números epoch; se toleran segundos,
 * ISO y Timestamp serializado). Cualquier otra cosa ⇒ null: el panel dice "todavía no
 * leímos", nunca inventa una verificación.
 */
function fechaDe(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const d = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string' && raw) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    const seg = typeof r._seconds === 'number' ? r._seconds : typeof r.seconds === 'number' ? r.seconds : null;
    if (seg != null) return fechaDe(seg * 1000);
  }
  return null;
}

/**
 * Normaliza el eje `authority` del status. PURA — exportada para testearla directo.
 * FAIL-CLOSED: sin el eje, o con valores fuera del contrato, devuelve null y el panel
 * conserva el comportamiento vigente (nada se habilita ni se deshabilita de más).
 */
export function normalizarAutoridad(raw: unknown): CatalogAuthorityView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const autoridad = typeof r.authority === 'string' ? r.authority : '';
  const relacion = typeof r.relationship === 'string' ? r.relationship : '';
  if (!AUTORIDADES.includes(autoridad) || !RELACIONES.includes(relacion)) return null;
  const st = (r.staleness && typeof r.staleness === 'object' && !Array.isArray(r.staleness)
    ? (r.staleness as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  return {
    autoridad: autoridad as AutoridadCatalogo,
    relacion: relacion as RelacionCatalogo,
    declarada: r.declared === true,
    motivos: Array.isArray(r.reasons)
      ? r.reasons.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [],
    frescura: {
      verificadoEn: fechaDe(st.metaVerifiedAt),
      fuenteLeidaEn: fechaDe(st.lastSourceCheckAt),
      importadoEn: fechaDe(st.lastImportFinishedAt),
    },
  };
}

// --- Etiquetas en criollo -----------------------------------------------------

/** Nombre de cada combinación autoridad+relación tal como la lee un comerciante. */
export function etiquetaCombo(autoridad: AutoridadCatalogo, relacion: RelacionCatalogo): string {
  if (autoridad === 'vendeyapy') {
    if (relacion === 'managed') return 'Lo administrás en VendeYaPy y se publica en Meta';
    if (relacion === 'none') return 'Lo administrás en VendeYaPy, solo para el bot';
    return 'Lo administrás en VendeYaPy';
  }
  if (autoridad === 'meta') return 'Lo administrás en Meta';
  return 'Lo publica otro sistema';
}

// --- Preview → apply (ADR-0022 §3) --------------------------------------------

/** Un requisito que impide el cambio, ya saneado. */
export interface BloqueoAutoridad {
  id: string;
  detalle: string;
}

export interface AuthorityPreviewView {
  ok: boolean;
  resumen: string;
  bloqueos: BloqueoAutoridad[];
  advertencias: string[];
  /** Cómo quedaría el modo si se aplica (null si el backend no lo mandó tipado). */
  estadoEsperado: AuthorityTarget | null;
  estadoEsperadoTexto: string;
  /** Evidencia para el apply. Con bloqueos SIEMPRE null (fail-closed). */
  planHash: string | null;
  runId: string | null;
  venceEn: Date | null;
}

function targetDe(raw: unknown): AuthorityTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const a = typeof r.authority === 'string' ? r.authority : '';
  const rel = typeof r.relationship === 'string' ? r.relationship : '';
  if (!AUTORIDADES.includes(a) || !RELACIONES.includes(rel)) return null;
  return { authority: a as AutoridadCatalogo, relationship: rel as RelacionCatalogo };
}

/**
 * Normaliza la respuesta del preview. PURA — exportada para testearla. Con bloqueos el
 * planHash se descarta aunque el backend lo mande por error: un plan bloqueado jamás es
 * evidencia aplicable. Todo texto libre se sanea.
 */
export function normalizarAuthorityPreview(raw: unknown): AuthorityPreviewView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bloqueos: BloqueoAutoridad[] = Array.isArray(r.bloqueos)
    ? (r.bloqueos as unknown[])
        .map((b) => {
          if (typeof b === 'string') return { id: b.trim().slice(0, 64), detalle: '' };
          if (!b || typeof b !== 'object') return null;
          const o = b as Record<string, unknown>;
          const id = typeof o.id === 'string' ? o.id.trim().slice(0, 64) : '';
          return id ? { id, detalle: sanitizarTextoPublico(o.detalle, 160) } : null;
        })
        .filter((b): b is BloqueoAutoridad => b != null)
    : [];
  const advertencias = Array.isArray(r.advertencias)
    ? (r.advertencias as unknown[]).map((a) => sanitizarTextoPublico(a, 200)).filter((a) => !!a)
    : [];
  const planHash = bloqueos.length === 0 && typeof r.planHash === 'string' && r.planHash ? r.planHash : null;
  const runId = typeof r.runId === 'string' && r.runId ? r.runId : null;
  const esperado = targetDe(r.estadoEsperado);
  return {
    ok: r.ok === true,
    resumen: sanitizarTextoPublico(r.resumen, 240),
    bloqueos,
    advertencias,
    estadoEsperado: esperado,
    estadoEsperadoTexto: esperado ? '' : sanitizarTextoPublico(r.estadoEsperado, 120),
    planHash,
    runId,
    venceEn: fechaDe(r.expiresAt),
  };
}

/** Bloqueos del preview traducidos (ids cerrados del contrato). */
export const BLOQUEO_LABEL: Record<string, string> = {
  invalid_target: 'Esa combinación no está permitida para tu catálogo.',
  ownership_incompatible:
    'La declaración de quién publica cada dato no es compatible con ese modo. Revisá primero “Fuente de verdad del catálogo”.',
  external_conflict: 'Hay una fuente externa publicando tu catálogo que entra en conflicto con ese modo.',
  outbox_not_terminal: 'Hay envíos a Meta pendientes: resolvelos antes de cambiar el modo.',
  import_run_in_flight: 'Hay una importación del catálogo en curso: esperá a que termine antes de cambiar el modo.',
  sync_run_in_flight: 'Hay una sincronización en curso: esperá a que termine antes de cambiar el modo.',
  connection_missing: 'Falta la conexión con Meta.',
  catalog_id_missing: 'Falta configurar qué catálogo de Meta se usa.',
  mapping_ambiguous:
    'Hay productos con vínculos ambiguos o cruzados con Meta: resolvelos desde la reconciliación antes de cambiar el modo.',
};

export function etiquetaBloqueo(id: string): string {
  return BLOQUEO_LABEL[id] ?? 'Hay un requisito pendiente que impide este cambio.';
}

/** true si el requisito faltante se resuelve desde la pantalla de Integración Meta. */
export function bloqueoLlevaAIntegraciones(id: string): boolean {
  return id === 'connection_missing' || id === 'catalog_id_missing';
}

/** Kinds del failed-precondition del apply, traducidos (ids cerrados del contrato). */
export const KIND_APPLY_LABEL: Record<string, string> = {
  preview_required: 'Falta revisar el cambio: generá la previsualización primero.',
  not_found: 'La previsualización ya no existe. Generá una nueva.',
  mismatch: 'La configuración cambió respecto de lo previsualizado. Generá una previsualización nueva.',
  expired: 'El preview venció, generá uno nuevo.',
  consumed: 'Esa previsualización ya se usó. Generá una nueva.',
  actor_mismatch: 'La previsualización la generó otra persona. Generá la tuya para confirmar.',
  concurrent_change: 'La configuración cambió mientras revisabas. Generá una previsualización nueva.',
  authority_relationship_blocked: 'El modo actual del catálogo no permite aplicar este cambio.',
};

export function etiquetaKindApply(kind: string | null): string {
  return (kind && KIND_APPLY_LABEL[kind]) || 'No se pudo aplicar el cambio. Generá una previsualización nueva.';
}

/**
 * Kind de un HttpsError del apply: primero `details.kind` (contrato), después el kind
 * incrustado en el mensaje (tolerancia). null si no se reconoce ninguno.
 */
export function kindDeError(e: unknown): string | null {
  const det = (e as { details?: unknown } | null)?.details;
  if (det && typeof det === 'object') {
    const k = (det as Record<string, unknown>).kind;
    if (typeof k === 'string' && k.trim()) return k.trim();
  }
  const msg = (e as { message?: string } | null)?.message ?? '';
  for (const k of Object.keys(KIND_APPLY_LABEL)) if (msg.includes(k)) return k;
  return null;
}

/** true si tras ese kind el preview mostrado dejó de ser aplicable (hay que regenerarlo). */
export function esPreviewInvalidado(kind: string | null): boolean {
  return (
    kind === 'preview_required' ||
    kind === 'not_found' ||
    kind === 'mismatch' ||
    kind === 'expired' ||
    kind === 'consumed' ||
    kind === 'actor_mismatch' ||
    kind === 'concurrent_change'
  );
}

/** ¿El cambio abandona la publicación activa? Exige la confirmación fuerte (tipear la palabra). */
export function esSalidaDeManaged(actual: CatalogAuthorityView | null, target: AuthorityTarget): boolean {
  return actual?.relacion === 'managed' && target.relationship !== 'managed';
}

/**
 * Consecuencias del cambio en criollo: qué se habilita/deshabilita y qué NO se toca.
 * La última línea es el invariante del apply (ADR-0022 §3): jamás borra productos,
 * vínculos, la conexión ni el feed.
 */
export function consecuenciasDe(actual: CatalogAuthorityView | null, target: AuthorityTarget): string[] {
  const lineas: string[] = [];
  if (target.relationship === 'none') {
    lineas.push(
      'Se deshabilitan la importación, la reconciliación y todo envío hacia Meta. El bot sigue vendiendo con el catálogo de acá.',
    );
  }
  if (target.relationship === 'mirror') {
    lineas.push(
      'Se habilitan importar y reconciliar para mantener el espejo local al día. VendeYaPy no escribe nada en Meta.',
    );
  }
  if (target.relationship === 'managed') {
    lineas.push(
      'Se habilita publicar hacia Meta, siempre con previsualización y confirmación. Este cambio no envía nada por sí solo.',
    );
  }
  if (esSalidaDeManaged(actual, target)) {
    lineas.push('VendeYaPy deja de publicar en Meta.');
  }
  lineas.push('No se toca nada más: tus productos, los vínculos con Meta, la conexión y el feed quedan como están.');
  return lineas;
}

// --- Frescura del espejo (ADR-0022 §5) ----------------------------------------

/** Con el espejo sin leerse hace más de esto, el panel lo marca como viejo. */
export const UMBRAL_ESPEJO_VIEJO_MS = 48 * 60 * 60 * 1000;

/** Antigüedad legible («hace 3 días», «hace 2 horas», «recién»). */
export function antiguedadLegible(d: Date, ahora: number = Date.now()): string {
  const ms = Math.max(0, ahora - d.getTime());
  if (ms < 60_000) return 'recién';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `hace ${min} minuto${min === 1 ? '' : 's'}`;
  const horas = Math.floor(min / 60);
  if (horas < 48) return `hace ${horas} hora${horas === 1 ? '' : 's'}`;
  const dias = Math.floor(horas / 24);
  return `hace ${dias} día${dias === 1 ? '' : 's'}`;
}

/**
 * Evidencia más reciente del espejo y si ya está vieja. `ultima: null` = no hay NINGUNA
 * lectura real: el panel jamás puede decir «verificado» en ese caso.
 */
export function frescuraEspejo(
  v: CatalogAuthorityView | null,
  ahora: number = Date.now(),
): { ultima: Date | null; vieja: boolean } {
  if (!v) return { ultima: null, vieja: false };
  const fechas = [v.frescura.verificadoEn, v.frescura.fuenteLeidaEn, v.frescura.importadoEn].filter(
    (d): d is Date => d != null,
  );
  if (fechas.length === 0) return { ultima: null, vieja: false };
  const ultima = fechas.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  return { ultima, vieja: ahora - ultima.getTime() > UMBRAL_ESPEJO_VIEJO_MS };
}

/** Tiempo restante legible para el vencimiento del preview («9 min», «45 s»). */
export function tiempoRestanteTexto(msRestante: number): string {
  if (msRestante <= 0) return '0 s';
  const min = Math.floor(msRestante / 60_000);
  if (min >= 1) return `${min} min`;
  return `${Math.max(1, Math.floor(msRestante / 1000))} s`;
}

// --- Gating por relación (ADR-0022 §4) ----------------------------------------

/**
 * Nombre mostrable del sistema que publica el catálogo. '' si no aplica ninguno.
 * Con autoridad `meta` es Meta misma; si hay fuente reconocida, su nombre SANEADO.
 */
export function nombreFuentePublicadora(own: CatalogOwnershipStatus | null): string {
  if (!own) return '';
  if (own.autoridad?.autoridad === 'meta') return 'Meta';
  const f = own.fuentes[0];
  if (f) return f.nombre || etiquetaTipoFuente(f.kind);
  return own.autoridad?.autoridad === 'external' ? 'otro sistema' : '';
}

/**
 * Motivo (en criollo) por el que la relación vigente bloquea escribir hacia Meta.
 * '' con `managed` o sin el contrato nuevo (el gating vigente de ADR-0015 sigue solo).
 */
export function motivoBloqueoPorRelacion(v: CatalogAuthorityView | null, fuente: string): string {
  if (!v) return '';
  if (v.relacion === 'none') {
    return 'El catálogo se usa solo para el bot: no se lee ni se envía nada a Meta.';
  }
  if (v.relacion === 'mirror') {
    return `Este catálogo lo publica ${fuente || 'otro sistema'}; VendeYaPy no escribe en Meta.`;
  }
  return '';
}

// --- Campos gobernados por la fuente (ADR-0022 §4, edición honesta) ------------

/**
 * Datos públicos que gobierna la fuente externa, derivados del status como lo hace la
 * tarjeta de propiedad: la lista `externos` o, con `external_managed` sin lista, todos.
 */
export function camposGobernadosPorFuente(own: CatalogOwnershipStatus | null): CampoPublico[] {
  if (!own || !own.configurado) return [];
  if (own.externos.length > 0) return own.externos;
  if (own.model === 'external_managed') return [...CAMPOS_PUBLICOS];
  return [];
}

const texto = (v: unknown): string => (v == null ? '' : String(v)).trim();

/**
 * Qué campos GOBERNADOS cambió esta edición respecto del producto guardado. Es lo que
 * dispara la confirmación explícita («tu cambio queda local, no se publica»): un guardado
 * que no toca campos gobernados jamás molesta. PURA — exportada para testearla.
 */
export function camposGobernadosCambiados(
  initial: Product,
  input: ProductInput,
  gobernados: readonly CampoPublico[],
): CampoPublico[] {
  if (gobernados.length === 0) return [];
  const marcaInicial = initial.brand ?? initial.perfume?.brand ?? '';
  const stockCambio = (initial.inventory?.stock ?? 0) !== input.stock;
  // La disponibilidad PUBLICADA deriva del stock Y del estado (meta/catalogOutbound:
  // availability = ACTIVE && stock): pasar ACTIVE↔INACTIVE cambia lo publicado tanto como
  // vaciar el stock — sin esto, ese cambio se guardaba en silencio (hallazgo B3).
  const statusCambio = initial.status !== input.status;
  const distinto: Record<CampoPublico, boolean> = {
    title: texto(initial.name) !== texto(input.name),
    description: texto(initial.description) !== texto(input.description),
    price: (initial.price ?? 0) !== input.price,
    currency: false, // fija en PYG: el form no permite cambiarla
    availability: stockCambio || statusCambio,
    inventory: stockCambio,
    brand: texto(marcaInicial) !== texto(input.brand),
    category: texto(initial.categoryId) !== texto(input.categoryId),
    image: (initial.images ?? []).join('\n') !== input.images.join('\n'),
    url: texto(initial.productUrl) !== texto(input.productUrl),
  };
  return gobernados.filter((c) => distinto[c]);
}

// --- Wrappers de los callables (OWNER/PLATFORM_ADMIN) ---------------------------

/**
 * Previsualiza un cambio de autoridad/relación. SOLO LECTURA: el backend calcula efectos
 * sin escribir y persiste el run como evidencia. Con bloqueos NO viene planHash.
 */
export async function fetchCatalogAuthorityPreview(
  tenantId: string,
  target: AuthorityTarget,
): Promise<AuthorityPreviewView> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogAuthorityPreview');
  const res = await call({ tenantId, target });
  return normalizarAuthorityPreview(res.data);
}

export interface AuthorityApplyResult {
  ok: boolean;
  antes: AuthorityTarget | null;
  despues: AuthorityTarget | null;
}

/**
 * Aplica el cambio previsualizado, ATADO a su evidencia (runId + planHash, TTL 10 min,
 * uso único, mismo actor). Si algo cambió desde el preview el backend responde
 * failed-precondition con un kind cerrado — se traduce con `etiquetaKindApply`.
 */
export async function applyCatalogAuthority(
  tenantId: string,
  runId: string,
  planHash: string,
): Promise<AuthorityApplyResult> {
  const call = httpsCallable(firebaseFunctions(), 'metaCatalogAuthorityApply');
  const res = await call({ tenantId, runId, planHash });
  const d = (res.data ?? {}) as Record<string, unknown>;
  return { ok: d.ok === true, antes: targetDe(d.antes), despues: targetDe(d.despues) };
}
