/**
 * lib/coverage.ts — Adapter del panel para la revisión de cobertura (COVERAGE-1C).
 * Lee el coverageRequest del cliente (rules: owner/manager; SELLER solo el asignado a su uid —
 * por eso la query del seller DEBE venir acotada con sellerUid, si no Firestore la rechaza
 * entera) y llama a las callables de decisión. El frontend JAMÁS escribe coverageRequests.
 */
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { CoverageRequest, CoverageFlowState, ShippingQuoteAttemptPhase } from '@vpw/shared';
import { shippingQuoteOfFlowState } from '@vpw/shared';
import type { ShippingConfirmPayload, ShippingSendState } from './shippingQuote';
import { firebaseDb, firebaseFunctions } from './firebase';

export interface CoverageViewer {
  role: string | null;
  uid: string | null;
}

const coverageCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'coverageRequests');

export interface CoverageLookup {
  /** El request más reciente del cliente (null = no hay). */
  request: CoverageRequest | null;
  /** true = el rol no puede leer (seller no asignado, etc.) → la UI no muestra nada. */
  denied: boolean;
}

/** Último request de cobertura del cliente, respetando el alcance del rol. */
export async function getCoverageRequestFor(
  tenantId: string,
  customerId: string,
  viewer: CoverageViewer,
): Promise<CoverageLookup> {
  try {
    const base = [where('customerId', '==', customerId)];
    if (viewer.role === 'SELLER') {
      if (!viewer.uid) return { request: null, denied: true };
      base.push(where('sellerUid', '==', viewer.uid));
    }
    const snap = await getDocs(query(coverageCol(tenantId), ...base));
    const reqs = snap.docs
      .map((d) => ({ ...(d.data() as CoverageRequest), id: d.id }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return { request: reqs[0] ?? null, denied: false };
  } catch (e) {
    // Solo permission-denied se trata como "sin acceso" (la UI no muestra nada, sin filtrar
    // existencia). Un error transitorio se relanza: react-query conserva los datos y reintenta.
    if ((e as { code?: string })?.code === 'permission-denied') return { request: null, denied: true };
    throw e;
  }
}

export interface CoverageDecisionResult {
  ok: boolean;
  status?: string;
  already?: boolean;
}

export async function approveCoverage(tenantId: string, requestId: string, expectedFingerprint: string): Promise<CoverageDecisionResult> {
  const fn = httpsCallable<{ tenantId: string; requestId: string; expectedFingerprint: string }, CoverageDecisionResult>(firebaseFunctions(), 'coverageApprove');
  return (await fn({ tenantId, requestId, expectedFingerprint })).data;
}

export async function rejectCoverage(tenantId: string, requestId: string, expectedFingerprint: string, note?: string): Promise<CoverageDecisionResult> {
  const fn = httpsCallable<{ tenantId: string; requestId: string; expectedFingerprint: string; note?: string }, CoverageDecisionResult>(firebaseFunctions(), 'coverageReject');
  return (await fn({ tenantId, requestId, expectedFingerprint, ...(note?.trim() ? { note: note.trim() } : {}) })).data;
}

export async function requestCoverageInfo(tenantId: string, requestId: string): Promise<CoverageDecisionResult> {
  const fn = httpsCallable<{ tenantId: string; requestId: string }, CoverageDecisionResult>(firebaseFunctions(), 'coverageRequestInfo');
  return (await fn({ tenantId, requestId })).data;
}

/**
 * HARDEN-1 — Estado del flujo de cobertura del tenant, para GATING DE UI solamente (mostrar u
 * ocultar acciones): la autoridad real es el gate server-side de las callables. Se consulta por
 * la callable `coverageFlowState` (Admin SDK) porque las rules niegan `config/checkout` al
 * SELLER (contiene cuentas bancarias) — review: leerlo con el SDK cliente dejaba al seller
 * asignado sin botones con el flujo ACTIVO. Solo permission-denied se trata como OFF; un error
 * transitorio se RELANZA (react-query conserva el último estado bueno y reintenta) — el gating
 * sigue fail-closed mientras no hay datos.
 *
 * SHIPPING-CHAT-4B: la respuesta incluye la política `shippingQuote` (SANEADA — jamás el doc de
 * config ni cuentas bancarias). Deploy skew: una función VIEJA sin el campo se normaliza a
 * `{status:'off'}` con el helper compartido — el panel se comporta legacy, nunca rompe.
 */
export async function getCoverageFlowState(tenantId: string): Promise<CoverageFlowState> {
  try {
    const fn = httpsCallable<{ tenantId: string }, CoverageFlowState>(firebaseFunctions(), 'coverageFlowState');
    const data = (await fn({ tenantId })).data;
    return { ...data, shippingQuote: shippingQuoteOfFlowState(data) };
  } catch (e) {
    if ((e as { code?: string })?.code === 'functions/permission-denied') {
      return { enabled: false, activationId: null, shippingQuote: { status: 'off' } };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// SHIPPING-CHAT-4B — Adapters de la saga de cotización (3C). El backend es la ÚNICA autoridad
// de parseo, permisos, huellas, idempotencia y dinero; estos adapters solo tipan el contrato.
// ---------------------------------------------------------------------------

export interface QuoteAndApproveResult {
  ok: boolean;
  status: string;
  /** Montos DEL SERVIDOR (la UI de éxito usa estos, jamás los derivados localmente). */
  shippingGs: number;
  totalGs: number;
}

/** Envía el mensaje canónico y aplica la aprobación (saga TX-A→claim→Meta→TX-C). */
export async function quoteAndApproveCoverage(tenantId: string, payload: ShippingConfirmPayload): Promise<QuoteAndApproveResult> {
  const fn = httpsCallable<{ tenantId: string } & ShippingConfirmPayload, QuoteAndApproveResult>(firebaseFunctions(), 'coverageQuoteAndApprove');
  return (await fn({ tenantId, ...payload })).data;
}

export interface QuoteAttemptState {
  ok: boolean;
  /** null = sin intento activo. La fase se DERIVA server-side del outbox (única fuente de verdad). */
  attempt: { quoteAttemptId: string; chargeGs: number; phase: ShippingQuoteAttemptPhase } | null;
}

/** Estado READ-ONLY del intento de cotización (recuperación tras F5/crash/otro dispositivo). */
export async function getCoverageQuoteAttemptState(tenantId: string, requestId: string): Promise<QuoteAttemptState> {
  const fn = httpsCallable<{ tenantId: string; requestId: string }, QuoteAttemptState>(firebaseFunctions(), 'coverageQuoteAttemptState');
  return (await fn({ tenantId, requestId })).data;
}

export interface ResolveQuoteUnknownResult {
  ok: boolean;
  resolved: 'delivered' | 'not_delivered';
  status?: string;
  shippingGs?: number;
  totalGs?: number;
}

/** Reconciliación HUMANA de un envío sin confirmar (OWNER/MANAGER; nota obligatoria; sin reenvío). */
export async function resolveCoverageQuoteUnknown(
  tenantId: string,
  requestId: string,
  quoteAttemptId: string,
  resolution: 'delivered' | 'not_delivered',
  note: string,
): Promise<ResolveQuoteUnknownResult> {
  const fn = httpsCallable<
    { tenantId: string; requestId: string; quoteAttemptId: string; resolution: string; note: string },
    ResolveQuoteUnknownResult
  >(firebaseFunctions(), 'coverageQuoteResolveUnknown');
  return (await fn({ tenantId, requestId, quoteAttemptId, resolution, note })).data;
}

/**
 * SHIPPING-CHAT-4B — Mapea el error de la saga a `ShippingSendState`. PURA y DEFENSIVA: lee
 * `details.kind` del FirebaseError del SDK (forma no garantizada — jamás se confía en strings
 * del mensaje); sin kind o con forma inválida ⇒ `generic`.
 *
 * Decisión de Codex (obligatoria): `in_progress` NO es unknown — otro worker está enviando; la
 * UI queda "en curso" (sending) y el polling de la fuente durable resuelve la fase real. Solo el
 * kind `unknown` CONFIRMADO por el backend produce el estado unknown local (la reconciliación
 * manual además exige la fase server 'unknown' vía coverageQuoteAttemptState).
 */
export function mapQuoteError(
  e: unknown,
  payload: ShippingConfirmPayload,
  /** Evidencia financiera para el estado `unknown` (el caller la deriva del contexto vigente). */
  evidencia: { canonical: string; totalGs: number },
): ShippingSendState {
  const requestId = payload.requestId;
  const err = e as { code?: unknown; details?: unknown; customData?: { details?: unknown } } | null;
  const details = (err?.details ?? err?.customData?.details) as { kind?: unknown } | null | undefined;
  const kind = details && typeof details === 'object' && typeof details.kind === 'string' ? details.kind : null;

  switch (kind) {
    case 'unknown':
      return { status: 'unknown', requestId, shippingGs: payload.confirmedShippingGs, totalGs: evidencia.totalGs, canonical: evidencia.canonical };
    case 'in_progress':
      // Otro worker tiene el lease: el ciclo local se CIERRA (idle) y el chip durable
      // "Envío del costo en curso…" (fase server) informa mientras el polling sigue.
      // Jamás unknown; jamás un 'sending' local sin mutation (sería absorbente — review 4B).
      return { status: 'idle' };
    case 'meta_rejected':
      return { status: 'error', requestId, kind: 'meta_rejected' };
    case 'cart_changed':
    case 'cart_invalid':
      return { status: 'error', requestId, kind: 'cart_changed' };
    case 'cart_changed_post_send':
      // Post-envío: el cliente YA recibió el costo y NO se aplicó — el texto no puede fingir
      // que nada salió (review 4B).
      return { status: 'error', requestId, kind: 'no_aplicado' };
    case 'location_changed':
      return { status: 'error', requestId, kind: 'location_changed' };
    case 'parse_mismatch':
      return { status: 'error', requestId, kind: 'parse_mismatch' };
    case 'expired':
      return { status: 'error', requestId, kind: 'expired' };
    case 'flow_off':
      return { status: 'error', requestId, kind: 'flow_off' };
    case 'quote_not_required':
      return { status: 'error', requestId, kind: 'quote_not_required' };
    case 'config_invalida':
      return { status: 'error', requestId, kind: 'config_invalida' };
    case 'config_cap':
      // config_cap SOLO ocurre en TX-C (post-envío): mismo tratamiento honesto.
      return { status: 'error', requestId, kind: 'no_aplicado' };
    case 'total_invalido':
      return { status: 'error', requestId, kind: 'total_invalido' };
    case 'quote_en_curso':
      return { status: 'error', requestId, kind: 'quote_en_curso' };
    case 'channel_unavailable':
      return { status: 'error', requestId, kind: 'channel_unavailable' };
    case 'not_assigned':
    case 'not_allowed':
      return { status: 'error', requestId, kind: 'not_assigned' };
    default:
      // already_decided / not_found / invalid_input / retry_tx / sin kind (incl. errores de
      // transporte ambiguos): generic. El caller invalida la revisión y la RECUPERACIÓN DURABLE
      // (pointer + attemptState) decide qué ofrecer — jamás un retry ciego desde el texto.
      return { status: 'error', requestId, kind: 'generic' };
  }
}

/**
 * Link a Google Maps construido EN EL CLIENTE y SOLO al hacer clic (nunca se pre-carga ningún
 * tercero ni se pone la ubicación en el DOM como URL antes del clic). PURA → testeable.
 */
export function mapsUrlFor(coordinates: { lat: number; lng: number }): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${coordinates.lat},${coordinates.lng}`)}`;
}
