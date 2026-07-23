'use client';

/**
 * CoverageReviewCard — Revisión humana de cobertura (COVERAGE-1C) + cotización de envío
 * (SHIPPING-CHAT-4B: integración de la saga 3C).
 *
 * Aparece en /conversations cuando el cliente seleccionado tiene un coverageRequest. Muestra la
 * ubicación SOLO a roles autorizados (rules), el carrito del snapshot y las acciones. El mapa se
 * abre ÚNICAMENTE al hacer clic (nada de terceros embebidos).
 *
 * SHIPPING-CHAT-4B — reglas de política (autoridad real: el backend; acá solo gating de UI):
 *  - off      ⇒ comportamiento legacy intacto (botón "Aprobar cobertura"; preview NO montado).
 *  - required ⇒ el botón viejo se OCULTA (el server lo rechazaría): la única vía es la saga —
 *               se monta ShippingQuotePreview con contexto SANEADO (jamás dirección/coordenadas/
 *               teléfono/customerId/banco/receivedVia/PNID/texto de outbox).
 *  - invalid  ⇒ fail-closed: sin aprobación (ni vieja ni nueva) + mensaje administrativo; el
 *               gate del composer sigue bloqueando textos de cotización.
 *  - flujo apagado / histórico / cargando ⇒ fail-closed (solo lectura), cero llamadas nuevas.
 *
 * RECUPERACIÓN DURABLE (decisión correctiva de Codex): la fuente del intento activo es
 * `req.shippingQuotePending` (pointer congelado) + `coverageQuoteAttemptState` (fase derivada
 * del outbox server-side); una aprobación completada persiste en `req.shippingQuote`. El estado
 * local `ShippingSendState` es solo la película de ESTA sesión — F5/otro dispositivo recuperan
 * desde las fuentes durables. `in_progress` NUNCA se muestra como unknown: la reconciliación
 * manual exige la fase server 'unknown'.
 *
 * Review 1C: el estado local (hecho/error/nota) se resetea al cambiar de request — el mensaje de
 * una decisión JAMÁS aparece sobre otro cliente/request; "pedir más info" no oculta las acciones.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CoverageRequest, ShippingQuotePolicy } from '@vpw/shared';
import { shippingQuoteOfFlowState, blocksManualShippingSend, formatCanonicalShippingMessage, computeOrderTotals, formatGuaranies } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import {
  getCoverageRequestFor,
  getCoverageFlowState,
  approveCoverage,
  rejectCoverage,
  requestCoverageInfo,
  mapsUrlFor,
  quoteAndApproveCoverage,
  getCoverageQuoteAttemptState,
  resolveCoverageQuoteUnknown,
  mapQuoteError,
} from '@/lib/coverage';
import { ShippingQuotePreview } from '@/components/ShippingQuotePreview';
import type { ManualShippingGate, ShippingConfirmPayload, ShippingDraftContext, ShippingSendState } from '@/lib/shippingQuote';

const ESTADO_LABEL: Record<CoverageRequest['status'], string> = {
  awaiting_location: 'Esperando la ubicación del cliente',
  pending_coverage_review: 'Cobertura pendiente de revisión',
  coverage_approved: 'Cobertura aprobada',
  coverage_rejected: 'Cobertura rechazada',
  coverage_expired: 'Solicitud vencida',
  coverage_cancelled: 'Cancelada por el cliente',
};

/** Roles que pueden VER la revisión (los demás ni consultan — evita polls denegados). */
const ROLES_LECTURA = new Set(['TENANT_OWNER', 'TENANT_MANAGER', 'SELLER', 'PLATFORM_ADMIN']);
/** Roles que pueden RECONCILIAR un envío sin confirmar (mismo criterio que el backend). */
const ROLES_RESOLUCION = new Set(['TENANT_OWNER', 'TENANT_MANAGER']);

/** Plantilla del atajo "Informar costo de envío" (el vendedor completa el monto). */
export const PLANTILLA_COSTO_ENVIO = 'El costo de envío para tu ubicación es ₲';

/** Estados de reanudación que exigen atención (los sanos — pending/processing/done — no avisan). */
const RESUME_AVISO: Partial<Record<string, string>> = {
  cancelled: 'La reanudación quedó cancelada (cambió la activación del flujo): atendé el pedido de este cliente a mano.',
  held_by_seller: 'La reanudación está retenida: el chat está tomado por el equipo — al devolverlo al bot, continúa sola.',
  send_failed: 'El mensaje de reanudación no se pudo enviar: se reintenta automáticamente.',
  send_unknown: 'El envío de la reanudación quedó sin confirmación: revisá el historial del chat antes de reintentar.',
};

const fmtFecha = (t: { toMillis?: () => number } | null | undefined) =>
  t?.toMillis ? new Date(t.toMillis()).toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/**
 * SHIPPING-CHAT-4B — Contexto SANEADO del preview. PURA y exportada para el test de no-PII: las
 * claves entregadas al preview son EXACTAMENTE las de ShippingDraftContext — jamás dirección,
 * coordenadas, teléfono, customerId, banco, receivedVia, PNID ni texto de outbox.
 */
export function buildShippingDraftContext(
  req: Pick<CoverageRequest, 'id' | 'status' | 'cartSnapshot' | 'locationFingerprint' | 'cartFingerprint' | 'expiresAt'>,
  policy: ShippingQuotePolicy,
  opts: { flowActive: boolean; canDecide: boolean; draft: string; nowMs: number },
): ShippingDraftContext {
  return {
    requestId: req.id,
    status: req.status,
    // HARDEN-1 (D1): subtotal AUSENTE = no cotizable (NaN ⇒ computeOrderTotals falla en la
    // derivación ⇒ sin aprobar) — jamás un total falso de solo-envío.
    subtotalGs: req.cartSnapshot?.subtotal ?? Number.NaN,
    locationFingerprint: req.locationFingerprint ?? '',
    cartFingerprint: req.cartFingerprint,
    expiresAtMs: req.expiresAt?.toMillis?.() ?? 0,
    nowMs: opts.nowMs,
    required: policy.status === 'required',
    flowActive: opts.flowActive,
    canDecide: opts.canDecide,
    maxChargeGs: policy.status === 'required' ? policy.maxChargeGs : 0,
    draft: opts.draft,
  };
}

/** Formateo SEGURO de guaraníes persistidos: dato corrupto ⇒ null (jamás rompe la tarjeta). */
function gsSeguro(n: number | null | undefined): string | null {
  try {
    return formatGuaranies(n as number);
  } catch {
    return null;
  }
}

/** Total con envío para mostrar evidencia/persistencia. null = no verificable (fail-closed). */
function totalSeguroDe(subtotalGs: number, shippingGs: number): number | null {
  try {
    return computeOrderTotals({ subtotalGs, discountGs: 0, shippingGs }).total;
  } catch {
    return null;
  }
}

export interface CoverageReviewCardProps {
  tenantId: string;
  customerId: string;
  /** SHIPPING-CHAT-4B — el draft es propiedad de la página (composer); acá solo se lee. */
  draft?: string;
  /** Completa la plantilla del costo en el composer (la página decide si pisa o solo enfoca). */
  onSetDraft?: (texto: string) => void;
  /** Enfocar el composer ("Seguir editando"). */
  onFocusComposer?: () => void;
  /** Llevar al historial del chat (estado unknown: revisar antes de actuar). */
  onReviewHistory?: () => void;
  /** Publica el gate visual del envío manual (aislado por customerId/requestId; sin PII). */
  onManualShippingGateChange?: (gate: ManualShippingGate) => void;
}

export function CoverageReviewCard({
  tenantId,
  customerId,
  draft = '',
  onSetDraft,
  onFocusComposer,
  onReviewHistory,
  onManualShippingGateChange,
}: CoverageReviewCardProps) {
  const { user, claims } = useAuth();
  const qc = useQueryClient();
  const [nota, setNota] = useState('');
  const [hecho, setHecho] = useState<string | null>(null); // SOLO decisiones (aprobar/rechazar)
  const [aviso, setAviso] = useState<string | null>(null); // informativo (pedir info): no oculta acciones
  const [error, setError] = useState<string | null>(null);
  const [send, setSend] = useState<ShippingSendState>({ status: 'idle' });
  const [notaResolucion, setNotaResolucion] = useState('');
  // HARDEN-2 (B): IDENTIDAD del ciclo local — `send` solo por requestId no alcanza cuando el
  // mismo request cambia de quoteAttemptId. `base` se congela al INICIAR el ciclo (qat del
  // pointer vigente, o null si el intento nuevo aún no materializó su pointer); `adoptado` se
  // fija UNA única vez cuando un `unknown` propio ve su pointer, verificado contra la HUELLA
  // congelada del payload (TX-A copia chargeGs + fingerprints al pointer: si no coinciden, el
  // pointer es de OTRO intento — fail-closed, sin importar el orden de renders). null = sin
  // ciclo. La comparación vive en el efecto de invalidación de más abajo.
  const [cicloQat, setCicloQat] = useState<{
    base: string | null;
    adoptado: string | null;
    huella: { chargeGs: number; loc: string; cart: string } | null;
  } | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const puedeVer = !!claims.role && ROLES_LECTURA.has(claims.role);
  const covQ = useQuery({
    queryKey: ['coverage', tenantId, customerId, claims.role, user?.uid],
    queryFn: () => getCoverageRequestFor(tenantId, customerId, { role: claims.role, uid: user?.uid ?? null }),
    enabled: !!tenantId && !!customerId && puedeVer,
    refetchInterval: 8000,
  });
  const req = covQ.data?.request ?? null;
  // HARDEN-1: estado del flujo para GATING DE UI (fail-closed mientras carga). La autoridad
  // sigue siendo el gate server-side: acá solo se ocultan acciones que el server rechazaría.
  const flowQ = useQuery({
    queryKey: ['coverage-flow', tenantId],
    queryFn: () => getCoverageFlowState(tenantId),
    enabled: !!tenantId && puedeVer,
    refetchInterval: 30000,
  });
  const flujo = flowQ.data ?? { enabled: false, activationId: null };
  // 4B: política normalizada TAMBIÉN acá (además del adapter): una respuesta vieja/mokeada sin
  // el campo ⇒ off (deploy skew seguro; los tests existentes del card no cambian).
  const policy: ShippingQuotePolicy = shippingQuoteOfFlowState(flowQ.data);

  // Cambió el request (otro cliente u otro intento del mismo): limpiar TODO el estado local —
  // draft/spinner/error/unknown/éxito de otra conversación jamás se muestran acá (aislamiento).
  const reqId = req?.id ?? null;
  useEffect(() => {
    setNota('');
    setHecho(null);
    setAviso(null);
    setError(null);
    setSend({ status: 'idle' });
    setNotaResolucion('');
    setCicloQat(null);
  }, [reqId, customerId]);

  // HARDEN-1 (B): el ref se sincroniza DURANTE el render (sin la ventana tardía de un useEffect):
  // un callback antiguo jamás puede pintar el request nuevo por un efecto que todavía no corrió.
  const reqIdRef = useRef<string | null>(reqId);
  reqIdRef.current = reqId;

  // Review HARDEN-1: las mutations de decisión también congelan sus ids en VARIABLES — un
  // resultado tardío tras cambiar de chat solo invalida (con los ids congelados) y jamás pinta
  // banner/error ni roba el foco sobre la revisión de OTRO cliente.
  interface DecisionVars { requestId: string; customerId: string; fingerprint: string; note: string }
  const congelarDecision = (): DecisionVars | null =>
    req ? { requestId: req.id, customerId, fingerprint: req.locationFingerprint ?? '', note: nota } : null;
  const invalidarPara = (cid: string) => qc.invalidateQueries({ queryKey: ['coverage', tenantId, cid] });
  const onDecidido = (msg: string, v: DecisionVars) => {
    invalidarPara(v.customerId);
    if (v.requestId !== reqIdRef.current) return;
    setHecho(msg); setAviso(null); setError(null); statusRef.current?.focus();
  };
  const onErr = (e: unknown, v: DecisionVars) => {
    invalidarPara(v.customerId);
    if (v.requestId !== reqIdRef.current) return;
    setError(e instanceof Error ? e.message : 'No se pudo completar la acción.');
  };

  // HARDEN-2 review: el "en vuelo" se ACOTA al request visible — una mutation colgada de OTRA
  // conversación (misma instancia de tarjeta, sin key) no bloquea ni etiqueta las acciones de
  // esta. La exclusión mutua del programa es POR SOLICITUD; los callbacks tardíos del request
  // ajeno ya están aislados por variables congeladas + reqIdRef.
  const enVueloDe = (m: { isPending: boolean; variables?: { requestId: string } }) =>
    m.isPending && m.variables?.requestId === reqId;

  const aprobar = useMutation({ mutationFn: (v: DecisionVars) => approveCoverage(tenantId, v.requestId, v.fingerprint), onSuccess: (_r, v) => onDecidido('Decisión registrada: cobertura aprobada.', v), onError: onErr });
  const rechazar = useMutation({ mutationFn: (v: DecisionVars) => rejectCoverage(tenantId, v.requestId, v.fingerprint, v.note), onSuccess: (_r, v) => onDecidido('Decisión registrada: cobertura rechazada.', v), onError: onErr });
  const pedirInfo = useMutation({
    mutationFn: (v: DecisionVars) => requestCoverageInfo(tenantId, v.requestId),
    onSuccess: (r, v) => {
      // HARDEN-2 (C): SIEMPRE refrescar los datos del cliente CONGELADO antes del guard visual
      // (igual que aprobar/rechazar) — un resultado tardío de otro chat no pinta UI, pero sí
      // deja frescos los datos de SU conversación.
      invalidarPara(v.customerId);
      if (v.requestId !== reqIdRef.current) return;
      setAviso(r.already ? 'Ya se pidió más información hace un momento.' : 'Le pedimos más detalle al cliente.'); setError(null);
    },
    onError: onErr,
  });
  const ocupado = enVueloDe(aprobar) || enVueloDe(rechazar) || enVueloDe(pedirInfo);

  // ---- SHIPPING-CHAT-4B: saga de cotización ----
  const flujoActivo0 = flujo.enabled && flujo.activationId !== null && flujo.activationId === (req?.activationId ?? null);
  const puedeDecidir0 = claims.role !== 'PLATFORM_ADMIN';
  const policyRequired = policy.status === 'required';
  const pending = req?.shippingQuotePending ?? null;

  /**
   * HARDEN-1 (C) — Variables de mutation con EVIDENCIA FINANCIERA CONGELADA al confirmar:
   * subtotal/total/canónico se fijan ANTES de llamar (computeOrderTotals); onError usa SOLO esto
   * (jamás `req`/`cartSnapshot` vivos). Si el total no se puede calcular ⇒ fail-closed sin
   * llamar la callable y sin NaN en ShippingSendState.
   */
  interface QuoteVars {
    payload: ShippingConfirmPayload;
    evidence: { shippingGs: number; subtotalGs: number; totalGs: number; canonical: string };
    customerId: string;
    requestId: string;
  }
  const congelarVars = (payload: ShippingConfirmPayload, subtotalGs: number): QuoteVars | null => {
    const totalGs = totalSeguroDe(subtotalGs, payload.confirmedShippingGs);
    if (totalGs === null) return null;
    return {
      payload,
      evidence: {
        shippingGs: payload.confirmedShippingGs,
        subtotalGs,
        totalGs,
        canonical: formatCanonicalShippingMessage(payload.confirmedShippingGs),
      },
      customerId,
      requestId: payload.requestId,
    };
  };
  /** Invalidaciones con los ids CONGELADOS de la mutation (jamás los del chat actualmente visible). */
  const invalidarQuotePara = (cid: string, rid: string | null) => {
    qc.invalidateQueries({ queryKey: ['coverage', tenantId, cid] });
    if (rid) qc.invalidateQueries({ queryKey: ['coverage-attempt', tenantId, rid] });
    qc.invalidateQueries({ queryKey: ['messages', tenantId, cid] });
    qc.invalidateQueries({ queryKey: ['customer', tenantId, cid] });
    qc.invalidateQueries({ queryKey: ['customerOpenOrder', tenantId, cid] });
    qc.invalidateQueries({ queryKey: ['conversations', tenantId] });
  };

  const quoteMut = useMutation({
    mutationFn: (v: QuoteVars) => quoteAndApproveCoverage(tenantId, v.payload),
    onMutate: (v) => setSend({ status: 'sending', requestId: v.requestId }),
    onSuccess: (r, v) => {
      invalidarQuotePara(v.customerId, v.requestId);
      if (v.requestId !== reqIdRef.current) return; // resolvió para otro request: no tocar la UI
      // Montos DEL SERVIDOR (jamás los derivados en el cliente) pero VALIDADOS (review HARDEN-1):
      // una respuesta malformada (skew/contrato roto) lanzaría en formatCanonicalShippingMessage
      // DENTRO del callback y dejaría un 'sending' absorbente — se degrada a error accionable.
      if (Number.isSafeInteger(r.shippingGs) && r.shippingGs >= 0 && Number.isSafeInteger(r.totalGs) && r.totalGs >= 0) {
        setSend({ status: 'sent', requestId: v.requestId, shippingGs: r.shippingGs, totalGs: r.totalGs, canonical: formatCanonicalShippingMessage(r.shippingGs) });
      } else {
        setSend({ status: 'error', requestId: v.requestId, kind: 'generic' });
      }
    },
    onError: (e, v) => {
      // Cualquier error (incluido transporte ambiguo sin kind) refresca la revisión: la fuente
      // durable (pointer + attemptState) decide qué ofrecer — jamás un retry ciego. La evidencia
      // del estado unknown es la CONGELADA al confirmar (HARDEN-1 C).
      invalidarQuotePara(v.customerId, v.requestId);
      if (v.requestId !== reqIdRef.current) return;
      setSend(mapQuoteError(e, v.payload, v.evidence));
    },
  });
  /** Confirmación con gate fail-closed: sin total calculable NO se llama la callable.
   *  HARDEN-2 (A): exclusión mutua con TODAS las demás acciones del request (resolver manual y
   *  las tres decisiones) — jamás dos mutations del mismo request en vuelo pisándose. */
  const confirmarQuote = (payload: ShippingConfirmPayload, subtotalGs: number) => {
    if (accionEnVuelo) return;
    // HARDEN-2 (B, review #2): la identidad se congela con el qat del pointer vigente SOLO si el
    // payload ES de ese pointer (recuperación: misma huella). Cotizar un monto NUEVO con un
    // pointer viejo a la vista es un REEMPLAZO — TX-A va a crear otro intento: la identidad
    // queda null y el pointer propio se reconoce después por la huella (adopción verificada).
    const p0 = covQ.data?.request?.shippingQuotePending ?? null;
    const esDelPointer =
      !!p0 &&
      p0.chargeGs === payload.confirmedShippingGs &&
      p0.locationFingerprint === payload.expectedLocationFingerprint &&
      p0.cartFingerprint === payload.expectedCartFingerprint;
    const qatCiclo = esDelPointer ? p0.quoteAttemptId : null;
    setCicloQat({
      base: qatCiclo,
      adoptado: qatCiclo,
      huella: { chargeGs: payload.confirmedShippingGs, loc: payload.expectedLocationFingerprint, cart: payload.expectedCartFingerprint },
    });
    const vars = congelarVars(payload, subtotalGs);
    if (!vars) {
      setSend({ status: 'error', requestId: payload.requestId, kind: 'total_invalido' });
      return;
    }
    quoteMut.mutate(vars);
  };

  // Recuperación DURABLE: la fase viene del server (outbox = única fuente de verdad) y se
  // consulta solo con pointer vivo o un ciclo local sin cerrar. Cambiar de conversación cambia
  // la queryKey (la vieja queda inactiva); terminal (sin intento / failed) detiene el polling.
  // Review 4B: NO exige política required ni activación vigente — un pointer vivo con la config
  // cambiada a mitad de saga DEBE seguir visible/cerrable (fail-open de lectura; el server
  // rechaza la acción si corresponde). El ciclo local habilita el poll solo en sending/unknown.
  // HARDEN-1 (A): la IDENTIDAD de la query incluye el quoteAttemptId del pointer — un intento
  // NUEVO dentro del mismo request estrena caché (la fase del intento anterior jamás se hereda).
  const attemptQ = useQuery({
    queryKey: ['coverage-attempt', tenantId, reqId, pending?.quoteAttemptId ?? 'sin-intento'],
    queryFn: () => getCoverageQuoteAttemptState(tenantId, reqId!),
    enabled: !!reqId && puedeVer && puedeDecidir0 && flujo.enabled && (!!pending || send.status === 'sending' || send.status === 'unknown'),
    refetchInterval: (q) => {
      const a = q.state.data?.attempt;
      if (!a || a.phase === 'failed') return false;
      return 10_000;
    },
  });
  // HARDEN-1 (A): la fase SOLO vale si la respuesta corresponde EXACTAMENTE al intento vigente
  // (pointer). Cualquier mismatch (respuesta vieja en caché, carrera de reemplazo) ⇒ fase null:
  // cero botones, cero reconciliación — se espera/refresca la fuente durable.
  const attemptVigente =
    pending && attemptQ.data?.attempt && attemptQ.data.attempt.quoteAttemptId === pending.quoteAttemptId
      ? attemptQ.data.attempt
      : null;
  const fase = attemptVigente?.phase ?? null;

  // HARDEN-1 (A): un intento NUEVO limpia la nota de reconciliación del anterior.
  const qatVigente = pending?.quoteAttemptId ?? null;
  useEffect(() => {
    setNotaResolucion('');
  }, [qatVigente]);

  // Reconciliación del ciclo LOCAL con la fuente durable (review 4B — hallazgo ALTO): sin una
  // mutation en vuelo, un `unknown` resuelto por otro dispositivo JAMÁS queda absorbente; y un
  // `error` contradicho por la aprobación persistida se cierra (el bloque persistido informa).
  const reqVivo = covQ.data?.request ?? null;
  const aplicadoDurable = reqVivo?.status === 'coverage_approved' && !!reqVivo.shippingQuote;
  const mutandoAhora = quoteMut.isPending;
  useEffect(() => {
    if (mutandoAhora) return;
    // 'sending' no se reconcilia: SOLO existe con la mutation en vuelo (in_progress mapea a idle).
    if (send.status === 'unknown') {
      // Review HARDEN-1 (ALTO): SOLO una respuesta POSTERIOR al error puede cerrar el unknown.
      // El onError invalida la query ⇒ mientras ese refetch está en vuelo (isFetching) los datos
      // visibles son los CACHEADOS de antes del error y no prueban nada — se ESPERA (cerrar acá
      // re-ofrecía "Continuar el envío" durante un envío sin confirmar). Con respuesta fresca:
      // sin intento activo ⇒ resuelto en otro lado (no queda absorbente); intento vigente en fase
      // ≠ unknown ⇒ ciclo cerrado; mismatch de attemptId ⇒ ambiguo, se sigue esperando.
      if (attemptQ.isFetching || !attemptQ.data) return;
      const sinIntento = attemptQ.data.attempt === null;
      if (sinIntento || (attemptVigente && attemptVigente.phase !== 'unknown')) setSend({ status: 'idle' });
    } else if (send.status === 'error' && aplicadoDurable) {
      setSend({ status: 'idle' });
    }
  }, [send.status, mutandoAhora, attemptQ.isFetching, attemptQ.data, attemptVigente, aplicadoDurable]);

  /** Payload de recuperación: SIEMPRE del pointer congelado (jamás huellas vivas). Un pointer
   *  con chargeGs corrupto ⇒ null (el formatter lanzaría dentro del onClick; el chip ya muestra
   *  '—' vía gsSeguro). */
  const payloadDelPointer = (): ShippingConfirmPayload | null => {
    const p = covQ.data?.request?.shippingQuotePending ?? null;
    if (!p || !req || !Number.isSafeInteger(p.chargeGs) || p.chargeGs < 0) return null;
    return {
      requestId: req.id,
      sellerDraft: formatCanonicalShippingMessage(p.chargeGs),
      confirmedShippingGs: p.chargeGs,
      expectedLocationFingerprint: p.locationFingerprint,
      expectedCartFingerprint: p.cartFingerprint,
    };
  };
  const continuarIntento = () => {
    const p = payloadDelPointer();
    if (!p) return;
    // HARDEN-1 (C): la evidencia de la recuperación también se congela ANTES de llamar (subtotal
    // del snapshot del request en este instante); sin total calculable ⇒ fail-closed sin llamar.
    confirmarQuote(p, covQ.data?.request?.cartSnapshot?.subtotal ?? Number.NaN);
  };

  const puedeResolver = !!claims.role && ROLES_RESOLUCION.has(claims.role);
  // Review 4B (ALTO) + HARDEN-1 (A/C): las VARIABLES congelan requestId/attemptId/monto/evidencia
  // y el customerId — los callbacks jamás leen `req`/`covQ` vivos; un resultado tardío tras
  // cambiar de chat se descarta (solo invalida, con los ids congelados).
  const resolver = useMutation({
    mutationFn: (vars: {
      requestId: string;
      quoteAttemptId: string;
      chargeGs: number;
      customerId: string;
      evidence: { canonical: string; totalGs: number } | null;
      resolution: 'delivered' | 'not_delivered';
      note: string;
    }) => resolveCoverageQuoteUnknown(tenantId, vars.requestId, vars.quoteAttemptId, vars.resolution, vars.note),
    onSuccess: (r, vars) => {
      invalidarQuotePara(vars.customerId, vars.requestId);
      if (vars.requestId !== reqIdRef.current) return; // el vendedor cambió de conversación
      if (r.resolved === 'delivered') {
        // HARDEN-1 (D2): un delivered MALFORMADO (sin montos del server) jamás se trata como
        // éxito ni como idle silencioso — error accionable y la fuente durable manda. Mismo
        // criterio que el formatter (entero seguro ≥ 0): un float pasaría isFinite y lanzaría.
        if (Number.isSafeInteger(r.shippingGs) && r.shippingGs >= 0 && Number.isSafeInteger(r.totalGs) && r.totalGs >= 0) {
          setSend({ status: 'sent', requestId: vars.requestId, shippingGs: r.shippingGs, totalGs: r.totalGs, canonical: formatCanonicalShippingMessage(r.shippingGs) });
        } else {
          setSend({ status: 'error', requestId: vars.requestId, kind: 'generic' });
        }
      } else {
        setSend({ status: 'idle' });
      }
      setNotaResolucion('');
    },
    onError: (e, vars) => {
      invalidarQuotePara(vars.customerId, vars.requestId);
      if (vars.requestId !== reqIdRef.current) return;
      // Un chargeGs corrupto NO puede lanzar dentro del callback (se tragaría el feedback):
      // el canónico solo se formatea si es un monto formateable.
      const canonicalSeguro = Number.isSafeInteger(vars.chargeGs) && vars.chargeGs >= 0 ? formatCanonicalShippingMessage(vars.chargeGs) : '';
      const pseudoPayload: ShippingConfirmPayload = {
        requestId: vars.requestId,
        sellerDraft: canonicalSeguro,
        confirmedShippingGs: vars.chargeGs,
        expectedLocationFingerprint: '',
        expectedCartFingerprint: '',
      };
      // HARDEN-1 (C): evidencia CONGELADA al iniciar la resolución (jamás el request vivo). Si no
      // había evidencia calculable, cualquier estado financiero se degrada a error genérico —
      // jamás NaN dentro de ShippingSendState.
      const st = mapQuoteError(e, pseudoPayload, vars.evidence ?? { canonical: canonicalSeguro, totalGs: Number.NaN });
      setSend(st.status === 'unknown' && !Number.isFinite(st.totalGs) ? { status: 'error', requestId: vars.requestId, kind: 'generic' } : st);
    },
  });

  // HARDEN-2 (A): exclusión mutua entre las CINCO acciones del mismo request — una decisión
  // (aprobar/rechazar/pedir info) y una mutation de la saga (cotizar/resolver) jamás corren a la
  // vez. Guard en el HANDLER además del disabled: el atributo solo no protege si el render que
  // deshabilita todavía no llegó. La autoridad final sigue siendo el server.
  const accionEnVuelo = ocupado || enVueloDe(quoteMut) || enVueloDe(resolver);
  const decidir = (m: { mutate: (v: DecisionVars) => void }) => {
    if (accionEnVuelo) return;
    const v = congelarDecision();
    if (v) m.mutate(v);
  };
  /** Inicio de la resolución manual: congela identidad + evidencia y excluye acciones paralelas. */
  const iniciarResolucion = (resolution: 'delivered' | 'not_delivered') => {
    const a = attemptVigente;
    if (!notaResolucion.trim() || accionEnVuelo || !a || !req) return;
    setCicloQat({ base: a.quoteAttemptId, adoptado: a.quoteAttemptId, huella: null });
    const t = totalSeguroDe(req.cartSnapshot?.subtotal ?? Number.NaN, a.chargeGs);
    resolver.mutate({
      requestId: req.id,
      quoteAttemptId: a.quoteAttemptId,
      chargeGs: a.chargeGs,
      customerId,
      evidence: t === null ? null : { canonical: formatCanonicalShippingMessage(a.chargeGs), totalGs: t },
      resolution,
      note: notaResolucion.trim(),
    });
  };

  // HARDEN-2 (B): invalidación del ciclo local por CAMBIO DE INTENTO dentro del mismo request.
  // Sin ciclo registrado ⇒ identidad insuficiente ⇒ fail-closed (se cierra). Mientras el ciclo
  // no adoptó pointer, SOLO una foto FRESCA de la revisión decide (review #1: un pointer
  // cacheado a mitad de saga por el poll no prueba nada — tras el settle, la invalidación del
  // callback está refetcheando y se ESPERA). Con foto fresca: pointer con la huella congelada
  // del payload (TX-A la copia tal cual) = intento PROPIO ⇒ se adopta UNA vez y la evidencia
  // local se conserva (unknown que espera resolución, y también sent/error cuyo pointer
  // sobrevive legítimamente, p.ej. channel_unavailable con outbox prepared); otra huella = OTRO
  // intento ⇒ idle: solo la evidencia/controles del intento vigente gobiernan. Trade-off
  // documentado: un intento sucesor con huella IDÉNTICA se adopta (evidencia financieramente
  // indistinguible por construcción; "Seguir editando" libera los controles durables).
  useEffect(() => {
    if (send.status === 'idle') return;
    if (quoteMut.isPending || resolver.isPending) return; // en vuelo: mandan los callbacks congelados
    if (!cicloQat) { setSend({ status: 'idle' }); return; }
    if (cicloQat.adoptado === null) {
      if (qatVigente === null || !pending) return; // aún sin pointer: nada que comparar (no limpiar temprano)
      if (covQ.isFetching) return; // foto potencialmente pre-settle: esperar la fresca
      const propio =
        !!cicloQat.huella &&
        pending.chargeGs === cicloQat.huella.chargeGs &&
        pending.locationFingerprint === cicloQat.huella.loc &&
        pending.cartFingerprint === cicloQat.huella.cart;
      if (propio) {
        setCicloQat({ ...cicloQat, adoptado: qatVigente }); // primera evidencia durable propia
      } else {
        setSend({ status: 'idle' });
      }
      return;
    }
    if (qatVigente !== null && qatVigente !== cicloQat.adoptado) setSend({ status: 'idle' });
  }, [send.status, quoteMut.isPending, resolver.isPending, cicloQat, qatVigente, pending, covQ.isFetching]);

  // ---- SHIPPING-CHAT-4B: gate VISUAL del envío manual (espejo del gate server de 3B; la
  // autoridad sigue siendo el server). Aislado por customerId/requestId; al desmontar o cambiar
  // de conversación se publica blocked:false.
  const gateCb = useRef(onManualShippingGateChange);
  useEffect(() => { gateCb.current = onManualShippingGateChange; });
  const gateBloquea = useMemo(() => {
    if (!req || !flujo.enabled || policy.status === 'off') return false;
    const enRevision =
      req.status === 'awaiting_location' ||
      req.status === 'pending_coverage_review' ||
      (req.status === 'coverage_approved' && req.resume?.status !== 'done');
    if (!enRevision) return false;
    return blocksManualShippingSend(draft, policy);
  }, [req, flujo.enabled, policy, draft]);
  const canQuoteRol = puedeDecidir0;
  useEffect(() => {
    gateCb.current?.({ customerId, requestId: reqId, blocked: gateBloquea, canQuote: canQuoteRol });
  }, [gateBloquea, customerId, reqId, canQuoteRol]);
  useEffect(() => {
    const cid = customerId;
    return () => { gateCb.current?.({ customerId: cid, requestId: null, blocked: false, canQuote: true }); };
  }, [customerId]);

  if (!puedeVer) return null;
  if (covQ.isLoading) return <div className="border-b border-sky-100 bg-sky-50/60 px-4 py-2 text-xs text-ink-400" role="status">Cargando revisión de cobertura…</div>;
  // Sin request o sin permiso (seller no asignado) → nada, sin filtrar existencia.
  if (!req || covQ.data?.denied) return null;

  const vencido = (req.expiresAt?.toMillis?.() ?? 0) <= Date.now();
  const pendiente = req.status === 'pending_coverage_review' && !vencido;
  // El soporte de plataforma LEE pero no decide (el server lo rechaza igual — acá ni se ofrece).
  const puedeDecidir = puedeDecidir0;
  // HARDEN-1: acciones SOLO con el flujo activo y la MISMA activación del request. Histórico o
  // deshabilitado → solo lectura (el server-side rechazaría igual; acá ni se ofrece el botón).
  const flujoActivo = flujoActivo0;
  const cliente = `…${customerId.slice(-4)}`;

  const context = buildShippingDraftContext(req, policy, {
    flowActive: flujoActivo,
    canDecide: puedeDecidir,
    draft,
    nowMs: Date.now(),
  });
  // El preview queda montado durante TODO el ciclo local (sending/sent/unknown/error) aunque la
  // revisión ya no esté pendiente — sin esto, el éxito desaparecía al refetchear covQ (review 4A).
  const cicloLocal = send.status !== 'idle' && send.requestId === reqId;
  const montarPreview = (policyRequired && flujoActivo && puedeDecidir && pendiente) || cicloLocal;

  // Aprobación PERSISTIDA (sobrevive F5/otro dispositivo/pérdida de respuesta): la fuente es el
  // request, no el estado local. El total se deriva EXCLUSIVAMENTE con computeOrderTotals.
  const quoteAplicado = req.status === 'coverage_approved' && req.shippingQuote ? req.shippingQuote : null;
  const totalPersistido = quoteAplicado ? totalSeguroDe(req.cartSnapshot?.subtotal ?? Number.NaN, quoteAplicado.chargeGs) : null;
  const mostrarPersistido = !!quoteAplicado && !(send.status === 'sent' && send.requestId === reqId);

  // Reconciliación: SOLO con fase server 'unknown' (jamás por un error local — decisión Codex).
  const mostrarReconciliacion = fase === 'unknown' && flujo.enabled && puedeDecidir;

  return (
    <section aria-label="Revisión de cobertura" className="border-b border-sky-100 bg-sky-50/60 px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-ink-800">
          📍 {ESTADO_LABEL[req.status] ?? req.status} · cliente {cliente}
        </span>
        <span className="text-ink-500">vence: {fmtFecha(req.expiresAt)}</span>
      </div>

      {req.location?.addressText && (
        <p className="mt-1 break-words text-ink-700">
          <span className="font-medium">Dirección:</span> {req.location.addressText}
          {req.location.name ? ` (${req.location.name})` : ''}
        </p>
      )}
      {req.location?.coordinates && (
        <button
          type="button"
          onClick={() => window.open(mapsUrlFor(req.location!.coordinates!), '_blank', 'noopener,noreferrer')}
          className="mt-1 font-semibold text-sky-700 underline-offset-2 hover:underline"
          aria-label="Abrir la ubicación del cliente en el mapa (pestaña nueva)"
        >
          Abrir mapa ↗
        </button>
      )}

      {req.cartSnapshot?.items?.length ? (
        <p className="mt-1 text-ink-600">
          🛒 {req.cartSnapshot.items.map((i) => `${i.name} x${i.quantity}`).join(' · ')} — Total ₲{' '}
          {gsSeguro(req.cartSnapshot.subtotal ?? Number.NaN) ?? '—'}
        </p>
      ) : null}
      {req.sellerName && <p className="mt-0.5 text-ink-500">Asignado a: {req.sellerName}</p>}

      {req.decision && (
        <p className="mt-1 text-ink-600">
          Decidido por <span className="font-medium">{req.decision.byName}</span> ({req.decision.byRole}) el {fmtFecha(req.decision.at)}.
        </p>
      )}
      {/* SHIPPING-CHAT-4B: costo aplicado PERSISTIDO (recuperación tras F5 — fail-closed si el
          total no se puede verificar con computeOrderTotals). */}
      {mostrarPersistido && (
        <p className="mt-1 font-medium text-mint-700" role="status">
          {gsSeguro(quoteAplicado!.chargeGs) !== null
            ? <>💸 Costo de envío enviado y aplicado: ₲ {gsSeguro(quoteAplicado!.chargeGs)}</>
            : <>💸 Hay un costo de envío aplicado pero no verificable: revisá el pedido en Pedidos.</>}
          {gsSeguro(quoteAplicado!.chargeGs) !== null && (totalPersistido !== null && gsSeguro(totalPersistido) !== null
            ? <> · Total del pedido ₲ {gsSeguro(totalPersistido)}</>
            : <> · El total no se pudo verificar: revisá el pedido en Pedidos.</>)}
        </p>
      )}
      {/* HARDEN-1 (review): sin esto, una reanudación cancelada/trabada parecía "resuelta". */}
      {req.decision && req.resume && RESUME_AVISO[req.resume.status] && (
        <p className="mt-1 font-medium text-amber-700" role="status">{RESUME_AVISO[req.resume.status]}</p>
      )}
      {vencido && !req.decision && (req.status === 'pending_coverage_review' || req.status === 'awaiting_location' || req.status === 'coverage_expired') && (
        <p className="mt-1 text-amber-700">La solicitud venció: el cliente tiene que escribir *pagar* para retomar.</p>
      )}

      {hecho && <p ref={statusRef} tabIndex={-1} className="mt-2 font-semibold text-mint-700 outline-none" role="status">{hecho}</p>}
      {aviso && !hecho && <p className="mt-2 font-medium text-sky-700" role="status">{aviso}</p>}
      {error && <p className="mt-2 font-semibold text-coral-700" role="alert">{error}</p>}

      {pendiente && !hecho && puedeDecidir && !flujoActivo && !flowQ.isLoading && !flowQ.isError && (
        <p className="mt-2 text-ink-500" role="status">
          {flujo.enabled
            ? 'Esta solicitud pertenece a una activación anterior del flujo de cobertura: queda en solo lectura, sin acciones disponibles.'
            : 'El flujo de cobertura está deshabilitado: esta solicitud queda en solo lectura, sin acciones disponibles.'}
        </p>
      )}

      {/* 4B: con config de cotización INVÁLIDA no hay aprobación posible (fail-closed). */}
      {pendiente && !hecho && puedeDecidir && flujoActivo && policy.status === 'invalid' && (
        <p className="mt-2 font-medium text-amber-700" role="status">
          La configuración de cotización de envío no es válida: avisá al administrador antes de aprobar.
        </p>
      )}

      {pendiente && !hecho && puedeDecidir && flujoActivo && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* 4B: el botón viejo SOLO con política off (con required/invalid el server lo rechaza). */}
          {policy.status === 'off' && (
            <button
              type="button"
              onClick={() => decidir(aprobar)}
              disabled={accionEnVuelo}
              className="rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50"
            >
              {enVueloDe(aprobar) ? 'Aprobando…' : 'Aprobar cobertura'}
            </button>
          )}
          <button
            type="button"
            onClick={() => decidir(rechazar)}
            disabled={accionEnVuelo}
            className="rounded-lg bg-coral-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-coral-500 disabled:opacity-50"
          >
            {enVueloDe(rechazar) ? 'Rechazando…' : 'Rechazar'}
          </button>
          <button
            type="button"
            onClick={() => decidir(pedirInfo)}
            disabled={accionEnVuelo}
            className="rounded-lg border border-ink-300 px-3 py-1.5 font-semibold text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50"
          >
            {enVueloDe(pedirInfo) ? 'Enviando…' : 'Pedir más información'}
          </button>
          <input
            type="text"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            maxLength={300}
            placeholder="Nota interna (opcional, solo si rechazás)"
            aria-label="Nota interna del rechazo (opcional, no se envía al cliente)"
            className="min-w-[12rem] flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-xs"
          />
        </div>
      )}

      {/* ---- SHIPPING-CHAT-4B: recuperación durable del intento (fase server) ---- */}
      {pending && fase === 'preparing' && !cicloLocal && pendiente && puedeDecidir && flujo.enabled && (
        <div className="mt-2 rounded-lg border border-sky-100 bg-white/70 px-2.5 py-2">
          <p className="font-medium text-sky-700" role="status">
            📨 Cotización de ₲ {gsSeguro(pending.chargeGs) ?? '—'} preparada; podés continuar el envío.
          </p>
          <button type="button" onClick={continuarIntento} disabled={accionEnVuelo} className="mt-1.5 rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50">
            Continuar el envío
          </button>
        </div>
      )}
      {pending && fase === 'in_progress' && !cicloLocal && (
        <p className="mt-2 font-medium text-sky-700" role="status">📨 Envío del costo en curso…</p>
      )}
      {pending && fase === 'sent_pending_approval' && !cicloLocal && puedeDecidir && flujo.enabled && (
        <div className="mt-2 rounded-lg border border-sky-100 bg-white/70 px-2.5 py-2">
          <p className="font-medium text-sky-700" role="status">
            ✉️ El mensaje del costo (₲ {gsSeguro(pending.chargeGs) ?? '—'}) ya se envió; falta completar la aprobación (no se reenvía).
          </p>
          <button type="button" onClick={continuarIntento} disabled={accionEnVuelo} className="mt-1.5 rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50">
            Completar la aprobación
          </button>
        </div>
      )}
      {pending && fase === 'failed' && !cicloLocal && pendiente && puedeDecidir && flujo.enabled && (
        <p className="mt-2 font-medium text-amber-700" role="status">
          El intento de cotización anterior quedó cerrado o inconsistente: revisá y volvé a cotizar.
        </p>
      )}

      {/* ---- Reconciliación MANUAL de un envío sin confirmar (SOLO fase server 'unknown') ---- */}
      {mostrarReconciliacion && puedeResolver && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2">
          <p className="font-semibold text-amber-800" role="alert">⚠ Envío sin confirmar — resolución manual</p>
          <p className="mt-0.5 text-ink-700">
            Intento con envío de ₲ {gsSeguro(pending!.chargeGs) ?? '—'}
          </p>
          <p className="mt-0.5 text-ink-600">
            Verificá en el WhatsApp del negocio si el mensaje llegó.{' '}
            <button type="button" onClick={() => onReviewHistory?.()} className="font-semibold text-sky-700 underline-offset-2 hover:underline">
              Revisar historial
            </button>{' '}
            Esta decisión queda auditada con tu nombre.
          </p>
          <input
            type="text"
            value={notaResolucion}
            onChange={(e) => setNotaResolucion(e.target.value)}
            maxLength={300}
            placeholder="Nota obligatoria (qué verificaste)"
            aria-label="Nota obligatoria de la verificación (queda auditada)"
            className="mt-1.5 w-full rounded-lg border border-ink-200 px-2 py-1.5 text-xs"
          />
          <div className="mt-1.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => iniciarResolucion('delivered')}
              disabled={!notaResolucion.trim() || accionEnVuelo}
              className="rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50"
            >
              {enVueloDe(resolver) ? 'Resolviendo…' : 'Sí llegó al cliente'}
            </button>
            <button
              type="button"
              onClick={() => iniciarResolucion('not_delivered')}
              disabled={!notaResolucion.trim() || accionEnVuelo}
              className="rounded-lg bg-coral-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-coral-500 disabled:opacity-50"
            >
              No llegó al cliente
            </button>
          </div>
        </div>
      )}
      {mostrarReconciliacion && !puedeResolver && (
        <p className="mt-2 font-medium text-amber-700" role="status">
          ⚠ Hay un envío de cotización sin confirmar: un encargado del negocio debe resolverlo.
        </p>
      )}

      {/* ---- SHIPPING-CHAT-4B: preview + saga (la única vía de aprobación con required) ---- */}
      {montarPreview && (
        <ShippingQuotePreview
          context={context}
          send={send}
          actionsBlocked={accionEnVuelo}
          onConfirm={(p) => confirmarQuote(p, req.cartSnapshot?.subtotal ?? Number.NaN)}
          onKeepEditing={() => {
            // "Seguir editando" CIERRA el ciclo local del error (vuelve a idle): el preview
            // re-deriva el borrador y la recuperación durable (pointer/fases) queda visible.
            // Hallazgo de la verificación visual — sin esto, el error quedaba pegado.
            if (send.status === 'error') setSend({ status: 'idle' });
            onFocusComposer?.();
          }}
          onShortcut={() => onSetDraft?.(PLANTILLA_COSTO_ENVIO)}
          onReviewHistory={() => onReviewHistory?.()}
        />
      )}
    </section>
  );
}
