/**
 * Loop de importación paginada del catálogo de Meta como función PURA e inyectable
 * (META-CATALOG-GENERIC-ONBOARDING-HARDEN-1). `MetaCatalogImport` delega acá la POLÍTICA de
 * re-invocación (cuándo seguir, cuándo cortar y con qué mensaje); el componente solo pinta.
 * Sin React ni Firebase: testeable con vitest inyectando `invocar`.
 *
 * Reglas que fija este loop (las que bloquearon la review adversarial):
 * - `already_running` / `failed` / `completed` → UNA invocación y afuera (no se re-invoca).
 * - `claim_lost` (otra invocación tomó el control del run) → fase 'tomado' SIN re-invocar y
 *   SIN pintar ese estado: la respuesta viene sin contadores y pisaría el avance real con
 *   ceros — el panel ofrece "Actualizar estado" para consultar el claim vigente.
 * - stopReason 'quota' o 'remote_error' (o lastError sin 'pages_budget') → corte declarado:
 *   NO se martilla en bucle un servicio degradado; queda "Reanudar" manual.
 * - Guard de no-progreso: si el backend no avanza (mismas páginas y sin `more`) 3 veces
 *   seguidas, se corta con honestidad en vez de seguir invocando.
 * - Tope defensivo de invocaciones por sesión de UI: jamás un bucle infinito.
 */

import type { MetaCatalogImportRunState } from './catalog';

/** Tope defensivo de invocaciones por sesión de UI (≈ miles de páginas): jamás un bucle infinito. */
export const MAX_INVOCACIONES = 500;

/** Invocaciones seguidas sin avance real antes de cortar. */
const MAX_SIN_PROGRESO = 3;

export interface ResultadoImportLoop {
  /**
   * 'abortado' = el componente se desmontó a mitad: no tocar más estado de UI.
   * 'tomado' = otra invocación tomó el control del run (claim_lost): `ultimo` conserva el
   * último avance REAL — el estado claim_lost (vacío) jamás se pinta.
   */
  fase: 'completado' | 'fallado' | 'cortado' | 'ocupado' | 'tomado' | 'abortado';
  ultimo: MetaCatalogImportRunState | null;
  errorMsg: string | null;
  /** Cuántas veces se invocó al backend (para los tests del guard de re-invocación). */
  invocaciones: number;
}

export interface ImportLoopDeps {
  /** Una invocación al backend (`metaCatalogImportRun`). El loop decide el `resume`. */
  invocar: (v: { resume: boolean }) => Promise<MetaCatalogImportRunState>;
  /** Avance real para pintar (solo se llama si `montado()` sigue true). */
  onAvance?: (r: MetaCatalogImportRunState) => void;
  /** false cuando el componente se desmontó: el loop corta sin tocar más nada. */
  montado?: () => boolean;
  maxInvocaciones?: number;
}

/** Mensaje legible de un error de callable (HttpsError trae `message` claro). */
export function errTextImport(e: unknown): string {
  const m = (e as { message?: string } | null)?.message;
  return m && m.trim() ? m : 'Error inesperado. Revisá tu conexión y probá de nuevo.';
}

export async function correrImportacionPaginada(reanudar: boolean, deps: ImportLoopDeps): Promise<ResultadoImportLoop> {
  const montado = deps.montado ?? (() => true);
  const max = deps.maxInvocaciones ?? MAX_INVOCACIONES;
  let ultimo: MetaCatalogImportRunState | null = null;
  let invocaciones = 0;
  let sinProgreso = 0;
  let paginasPrevias = -1;
  try {
    for (let i = 0; i < max; i++) {
      const r = await deps.invocar({ resume: reanudar || i > 0 });
      invocaciones += 1;
      if (!montado()) return { fase: 'abortado', ultimo, errorMsg: null, invocaciones };
      // Otra invocación tomó el control del run (fencing del backend): esta respuesta viene
      // SIN contadores — NO se pinta (onAvance con ese estado pisaría el avance real con
      // ceros) y NO se re-invoca. El CTA del panel es consultar el estado del claim vigente.
      if (r.status === 'claim_lost') {
        return {
          fase: 'tomado',
          ultimo,
          errorMsg: r.lastError ?? 'Otra invocación tomó el control de esta importación. Consultá el estado actual.',
          invocaciones,
        };
      }
      ultimo = r;
      deps.onAvance?.(r);
      // Otra sesión tiene el run tomado: se muestra SU avance (contadores reales del run
      // vigente, que la normalización ya sacó del `run` anidado) y NO se re-invoca.
      if (r.status === 'already_running') return { fase: 'ocupado', ultimo, errorMsg: null, invocaciones };
      if (r.status === 'failed') return { fase: 'fallado', ultimo, errorMsg: null, invocaciones };
      if (r.status === 'completed') return { fase: 'completado', ultimo, errorMsg: null, invocaciones };
      // status 'running' con corte declarado (cuota agotada, Meta con problemas): NO se
      // re-invoca en bucle — cada reintento costaría lecturas completas y GETs a Meta
      // contra un servicio ya degradado. Se muestra el motivo y queda "Reanudar" manual.
      // `pages_budget` (presupuesto de páginas de la invocación) es el avance normal.
      if (r.stopReason === 'quota' || r.stopReason === 'remote_error' || (r.lastError && r.stopReason !== 'pages_budget')) {
        return {
          fase: 'cortado',
          ultimo,
          errorMsg:
            r.lastError ??
            (r.stopReason === 'quota'
              ? 'Se alcanzó el límite del plan. Revisá el plan y tocá "Reanudar" para continuar.'
              : 'Meta no respondió bien. Esperá un momento y tocá "Reanudar".'),
          invocaciones,
        };
      }
      // Si el backend no avanza (mismas páginas y sin `more`), cortamos con honestidad
      // en vez de martillar el servidor.
      if (!r.more && r.pagesDone === paginasPrevias) {
        sinProgreso += 1;
        if (sinProgreso >= MAX_SIN_PROGRESO) {
          return {
            fase: 'cortado',
            ultimo,
            errorMsg: 'La importación no está avanzando. Esperá un momento y tocá "Reanudar".',
            invocaciones,
          };
        }
      } else {
        sinProgreso = 0;
      }
      paginasPrevias = r.pagesDone;
    }
    return {
      fase: 'cortado',
      ultimo,
      errorMsg: 'La importación sigue en curso (catálogo muy grande). Tocá "Reanudar" para continuar.',
      invocaciones,
    };
  } catch (e) {
    if (!montado()) return { fase: 'abortado', ultimo, errorMsg: null, invocaciones };
    return { fase: 'cortado', ultimo, errorMsg: errTextImport(e), invocaciones };
  }
}
