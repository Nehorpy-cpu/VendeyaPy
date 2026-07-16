/**
 * lib/coverage.ts — Adapter del panel para la revisión de cobertura (COVERAGE-1C).
 * Lee el coverageRequest del cliente (rules: owner/manager; SELLER solo el asignado a su uid —
 * por eso la query del seller DEBE venir acotada con sellerUid, si no Firestore la rechaza
 * entera) y llama a las callables de decisión. El frontend JAMÁS escribe coverageRequests.
 */
import { collection, getDocs, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { CoverageRequest, CoverageActivation } from '@vpw/shared';
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
 */
export async function getCoverageFlowState(tenantId: string): Promise<CoverageActivation> {
  try {
    const fn = httpsCallable<{ tenantId: string }, CoverageActivation>(firebaseFunctions(), 'coverageFlowState');
    return (await fn({ tenantId })).data;
  } catch (e) {
    if ((e as { code?: string })?.code === 'functions/permission-denied') return { enabled: false, activationId: null };
    throw e;
  }
}

/**
 * Link a Google Maps construido EN EL CLIENTE y SOLO al hacer clic (nunca se pre-carga ningún
 * tercero ni se pone la ubicación en el DOM como URL antes del clic). PURA → testeable.
 */
export function mapsUrlFor(coordinates: { lat: number; lng: number }): string {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${coordinates.lat},${coordinates.lng}`)}`;
}
