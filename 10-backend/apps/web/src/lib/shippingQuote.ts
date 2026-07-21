/**
 * lib/shippingQuote.ts — SHIPPING-CHAT-2B (+3B: clasificación consolidada en @vpw/shared)
 * Derivación PURA del preview de costo de envío (sin React, sin Firebase, sin efectos).
 * Reutiliza EXCLUSIVAMENTE la lógica compartida de `@vpw/shared` (parser + helpers + gate):
 * no duplica regex, parseo, formato de dinero, cálculo financiero ni clasificación de bloqueo.
 *
 * IMPORTANTE: `blocksManualSend` acá es SOLO ayuda de UI. La AUTORIDAD es el gate server-side
 * de `sendManualMessage` (SHIPPING-CHAT-3B) — ambos usan la MISMA clasificación compartida
 * (`blocksByParseResult` / `blocksManualShippingSend` de @vpw/shared): una sola fuente.
 */
import {
  parseShippingCost,
  computeOrderTotals,
  formatGuaranies,
  formatCanonicalShippingMessage,
  blocksByParseResult,
  blocksManualShippingSend,
} from '@vpw/shared';
import type { ShippingParseReason, ShippingParseResult, CoverageQuoteAndApproveInput, CoverageStatus, ShippingQuotePolicy } from '@vpw/shared';

/** Contexto SANEADO que recibe el componente. Sin PII: nunca dirección, coordenadas ni datos bancarios. */
export interface ShippingDraftContext {
  requestId: string;
  status: CoverageStatus;
  /** Subtotal de PRODUCTOS (público, del cartSnapshot). El envío jamás se suma acá. */
  subtotalGs: number;
  locationFingerprint: string;
  cartFingerprint: string;
  /** Vencimiento de la revisión (ms epoch). */
  expiresAtMs: number;
  /** "Ahora" en ms (lo pasa el padre → derivación pura y testeable). */
  nowMs: number;
  required: boolean;
  flowActive: boolean;
  canDecide: boolean;
  maxChargeGs: number;
  draft: string;
}

/** Clasificación del borrador (ayuda de UI). */
export type DraftClass = 'idle_unrelated' | 'valid_amount' | 'valid_free' | 'invalid_price_attempt' | 'invalid_configuration';

/** Payload de confirmación: exactamente el contrato compartido SIN tenantId (el backend usa claims). */
export type ShippingConfirmPayload = Omit<CoverageQuoteAndApproveInput, 'tenantId'>;

/**
 * ¿El texto NO debe poder enviarse como mensaje manual crudo? — SHIPPING-CHAT-3B: delega en la
 * clasificación COMPARTIDA de @vpw/shared (misma función que usa el gate server-side; paridad
 * por identidad, no por copia). true para matched/free e intentos no-limpios; false para texto
 * común y para `limite_invalido` (error de CONFIG — la re-clasificación de intención la hace
 * `blocksManualShippingSend` con la política).
 */
export const blocksManualSend: (r: ShippingParseResult) => boolean = blocksByParseResult;

/** Clasifica el borrador (decisión 5). */
export function classifyDraft(r: ShippingParseResult): DraftClass {
  if (r.kind === 'matched') return 'valid_amount';
  if (r.kind === 'free') return 'valid_free';
  if (r.reason === 'limite_invalido') return 'invalid_configuration';
  if (r.reason === 'vacio' || r.reason === 'sin_contexto_envio' || r.reason === 'sin_monto') return 'idle_unrelated';
  return 'invalid_price_attempt';
}

/** Texto visible para un motivo `none` (null cuando no hay que mostrar nada — idle/unrelated). */
export function messageForReason(reason: ShippingParseReason): string | null {
  switch (reason) {
    case 'monto_ambiguo':
      return 'Detecté más de un monto. Escribí un solo costo claro (ej: ₲30.000).';
    case 'monto_no_exacto':
      return 'Ese texto da un rango o aproximado. Escribí un costo exacto (ej: ₲30.000).';
    case 'monto_negado':
      return 'Tu mensaje niega ese costo. Escribí el costo que sí cobrás.';
    case 'monto_invalido':
      return 'No pude leer un monto válido. Revisá el número (ej: ₲30.000).';
    case 'excede_maximo':
      return 'Ese costo supera el máximo permitido. Revisalo antes de enviar.';
    case 'cero_sin_gratuidad':
      return 'Si el envío es gratis, escribilo así (ej: "envío gratis"). Si tiene costo, poné el monto.';
    case 'gratis_con_monto':
      return 'Tu mensaje mezcla "gratis" con un monto. Dejá solo el costo o solo "envío gratis".';
    case 'gratuidad_negada':
      return 'Ese mensaje niega la gratuidad. Escribí el costo que sí cobrás o "envío gratis".';
    case 'gratuidad_condicional':
      return 'Esa gratuidad es condicional. Escribí un costo exacto o "envío gratis" sin condiciones.';
    case 'limite_invalido':
      return 'La configuración del máximo de envío no es válida. Avisá al administrador antes de cotizar.';
    default:
      return null; // vacio | sin_contexto_envio | sin_monto
  }
}

/** Errores de envío/aprobación distintos de `unknown` (que es su propio estado). */
export type ShippingSendErrorKind =
  | 'meta_rejected'
  | 'cart_changed'
  | 'location_changed'
  | 'fingerprint_stale'
  | 'expired'
  | 'flow_off'
  | 'not_assigned'
  | 'over_max'
  | 'generic';

/**
 * Ciclo de vida del envío/aprobación (controlado por el PADRE; el componente no muta nada).
 * HARDEN-1: todo estado NO-idle lleva `requestId` para AISLAMIENTO por conversación — el componente
 * solo lo muestra si `send.requestId === context.requestId`. `unknown` es su propio estado y EXIGE
 * evidencia financiera (requestId, shippingGs, totalGs, canonical) — nunca opcional.
 */
export type ShippingSendState =
  | { status: 'idle' }
  | { status: 'sending'; requestId: string }
  | { status: 'sent'; requestId: string; shippingGs: number; totalGs: number; canonical: string }
  | { status: 'error'; requestId: string; kind: ShippingSendErrorKind; shippingGs?: number; totalGs?: number; canonical?: string }
  | { status: 'unknown'; requestId: string; shippingGs: number; totalGs: number; canonical: string };

/** Texto EXACTO por resultado de envío/aprobación (incluye `unknown`). */
export const SEND_ERROR_TEXT: Record<ShippingSendErrorKind | 'unknown', string> = {
  unknown: 'No pudimos confirmar el envío. Revisá el historial antes de intentar otra acción.',
  meta_rejected: 'WhatsApp no aceptó el mensaje, así que no aprobamos la cobertura. Revisá el chat y volvé a intentar.',
  cart_changed: 'El carrito cambió: volvé a informar el costo de envío antes de aprobar.',
  location_changed: 'El cliente cambió su ubicación: la cobertura se reabre y hay que recotizar.',
  fingerprint_stale: 'Lo que ves cambió recién. Actualizamos la revisión; volvé a confirmar el costo.',
  expired: 'La solicitud venció: el cliente tiene que escribir *pagar* para retomar.',
  flow_off: 'El flujo de cobertura está deshabilitado: no se puede aprobar.',
  not_assigned: 'Esta conversación no está asignada a vos: no podés aprobar la cobertura.',
  over_max: 'Ese costo supera el máximo permitido. Revisalo antes de enviar.',
  generic: 'No se pudo aprobar la cobertura. Revisá e intentá de nuevo.',
};

/** View-model derivado del contexto (todo lo que el componente necesita para renderizar). */
export interface ShippingQuoteVM {
  /** El componente renderiza algo (usable). */
  visible: boolean;
  /** Usable pero la revisión venció ⇒ nota, sin acciones. */
  expired: boolean;
  draftClass: DraftClass;
  reason: ShippingParseReason | null;
  shippingGs: number | null;
  subtotalText: string;
  shippingText: string | null;
  totalText: string | null;
  canonical: string | null;
  /** Texto de bloqueo/configuración (para invalid_price_attempt / invalid_configuration). */
  message: string | null;
  blocksManualSend: boolean;
  canApprove: boolean;
  payload: ShippingConfirmPayload | null;
}

/** Formatea guaraníes con el helper compartido; '—' si el valor no es representable (defensa). */
function fmt(gs: number): string {
  try {
    return formatGuaranies(gs);
  } catch {
    return '—';
  }
}

/** Formateo de guaraníes para el componente (reusa el helper compartido; sin duplicar formato). */
export function formatGs(gs: number): string {
  return fmt(gs);
}

/**
 * Deriva el view-model del preview. PURA: mismas entradas ⇒ mismo resultado, sin efectos ni reloj propio.
 */
export function deriveShippingQuote(ctx: ShippingDraftContext): ShippingQuoteVM {
  const hidden: ShippingQuoteVM = {
    visible: false,
    expired: false,
    draftClass: 'idle_unrelated',
    reason: null,
    shippingGs: null,
    subtotalText: '',
    shippingText: null,
    totalText: null,
    canonical: null,
    message: null,
    blocksManualSend: false,
    canApprove: false,
    payload: null,
  };

  // Solo aplica con quote obligatorio, flujo activo, permiso de decisión y revisión pendiente.
  const usable = ctx.required && ctx.flowActive && ctx.canDecide && ctx.status === 'pending_coverage_review';
  if (!usable) return hidden;

  const parse = parseShippingCost(ctx.draft, { maxChargeGs: ctx.maxChargeGs });
  // SHIPPING-CHAT-3B: el bloqueo de envío manual usa la MISMA función compartida que el gate
  // server-side (`blocksManualShippingSend`): con max válido ⇒ política required; inválido ⇒
  // política invalid (re-clasifica SOLO la intención con el default compartido — jamás aprueba
  // ni reemplaza la config del tenant: canApprove/payload siguen dependiendo del parse principal).
  const policy: ShippingQuotePolicy =
    Number.isSafeInteger(ctx.maxChargeGs) && ctx.maxChargeGs > 0
      ? { status: 'required', maxChargeGs: ctx.maxChargeGs }
      : { status: 'invalid' };
  const draftClass = classifyDraft(parse);
  const blocks = blocksManualShippingSend(ctx.draft, policy);
  const reason = parse.kind === 'none' ? parse.reason : null;
  const subtotalText = fmt(ctx.subtotalGs);

  const expired = ctx.expiresAtMs <= ctx.nowMs;
  if (expired) {
    return { ...hidden, visible: true, expired: true, draftClass, reason, blocksManualSend: blocks, subtotalText };
  }

  let shippingGs: number | null = null;
  let shippingText: string | null = null;
  let totalText: string | null = null;
  let canonical: string | null = null;
  let payload: ShippingConfirmPayload | null = null;
  let canApprove = false;
  let message: string | null = parse.kind === 'none' ? messageForReason(parse.reason) : null;

  if (parse.kind === 'matched' || parse.kind === 'free') {
    try {
      const totals = computeOrderTotals({ subtotalGs: ctx.subtotalGs, discountGs: 0, shippingGs: parse.shippingGs });
      shippingGs = parse.shippingGs;
      shippingText = formatGuaranies(parse.shippingGs); // shipping es opcional en OrderTotals; el valor exacto es parse.shippingGs
      totalText = formatGuaranies(totals.total);
      canonical = formatCanonicalShippingMessage(shippingGs);
      payload = {
        requestId: ctx.requestId,
        sellerDraft: ctx.draft,
        expectedLocationFingerprint: ctx.locationFingerprint,
        expectedCartFingerprint: ctx.cartFingerprint,
        confirmedShippingGs: shippingGs,
      };
      canApprove = true;
    } catch {
      // Subtotal inválido / overflow del total: no se puede cotizar con seguridad.
      message = 'No pude calcular el total con el subtotal actual. Revisá el carrito antes de aprobar.';
      shippingGs = null;
      canApprove = false;
    }
  }

  return {
    visible: true,
    expired: false,
    draftClass,
    reason,
    shippingGs,
    subtotalText,
    shippingText,
    totalText,
    canonical,
    message,
    blocksManualSend: blocks,
    canApprove,
    payload,
  };
}
