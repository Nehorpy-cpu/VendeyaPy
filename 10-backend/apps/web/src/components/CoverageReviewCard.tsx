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
    subtotalGs: req.cartSnapshot?.subtotal ?? 0,
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
  }, [reqId, customerId]);

  const invalidar = () => qc.invalidateQueries({ queryKey: ['coverage', tenantId, customerId] });
  /** 4B: tras confirmar/resolver, TODO lo que muestra dinero/mensajes se refresca. */
  const invalidarQuote = () => {
    invalidar();
    qc.invalidateQueries({ queryKey: ['coverage-attempt', tenantId, reqId] });
    qc.invalidateQueries({ queryKey: ['messages', tenantId, customerId] });
    qc.invalidateQueries({ queryKey: ['customer', tenantId, customerId] });
    qc.invalidateQueries({ queryKey: ['customerOpenOrder', tenantId, customerId] });
    qc.invalidateQueries({ queryKey: ['conversations', tenantId] });
  };
  const onDecidido = (msg: string) => { setHecho(msg); setAviso(null); setError(null); invalidar(); statusRef.current?.focus(); };
  const onErr = (e: unknown) => { setError(e instanceof Error ? e.message : 'No se pudo completar la acción.'); invalidar(); };

  const fingerprint = req?.locationFingerprint ?? '';
  const aprobar = useMutation({ mutationFn: () => approveCoverage(tenantId, req!.id, fingerprint), onSuccess: () => onDecidido('Decisión registrada: cobertura aprobada.'), onError: onErr });
  const rechazar = useMutation({ mutationFn: () => rejectCoverage(tenantId, req!.id, fingerprint, nota), onSuccess: () => onDecidido('Decisión registrada: cobertura rechazada.'), onError: onErr });
  const pedirInfo = useMutation({
    mutationFn: () => requestCoverageInfo(tenantId, req!.id),
    onSuccess: (r) => { setAviso(r.already ? 'Ya se pidió más información hace un momento.' : 'Le pedimos más detalle al cliente.'); setError(null); },
    onError: onErr,
  });
  const ocupado = aprobar.isPending || rechazar.isPending || pedirInfo.isPending;

  // ---- SHIPPING-CHAT-4B: saga de cotización ----
  const flujoActivo0 = flujo.enabled && flujo.activationId !== null && flujo.activationId === (req?.activationId ?? null);
  const puedeDecidir0 = claims.role !== 'PLATFORM_ADMIN';
  const policyRequired = policy.status === 'required';
  const pending = req?.shippingQuotePending ?? null;

  const evidenciaDe = (p: ShippingConfirmPayload) => ({
    canonical: formatCanonicalShippingMessage(p.confirmedShippingGs),
    totalGs: totalSeguroDe(req?.cartSnapshot?.subtotal ?? Number.NaN, p.confirmedShippingGs) ?? Number.NaN,
  });

  // Aislamiento de callbacks en vuelo (review 4B): un resultado que llega DESPUÉS de cambiar de
  // conversación jamás pinta el estado del request nuevo — se descarta y solo se invalida.
  const reqIdRef = useRef<string | null>(reqId);
  useEffect(() => { reqIdRef.current = reqId; }, [reqId]);

  const quoteMut = useMutation({
    mutationFn: (p: ShippingConfirmPayload) => quoteAndApproveCoverage(tenantId, p),
    onMutate: (p) => setSend({ status: 'sending', requestId: p.requestId }),
    onSuccess: (r, p) => {
      invalidarQuote();
      if (p.requestId !== reqIdRef.current) return; // resolvió para otro request: no tocar la UI
      // Montos DEL SERVIDOR (jamás los derivados en el cliente); el canónico visible se deriva
      // del monto confirmado — nunca del sellerDraft.
      setSend({ status: 'sent', requestId: p.requestId, shippingGs: r.shippingGs, totalGs: r.totalGs, canonical: formatCanonicalShippingMessage(r.shippingGs) });
    },
    onError: (e, p) => {
      // Cualquier error (incluido transporte ambiguo sin kind) refresca la revisión: la fuente
      // durable (pointer + attemptState) decide qué ofrecer — jamás un retry ciego.
      invalidarQuote();
      if (p.requestId !== reqIdRef.current) return;
      setSend(mapQuoteError(e, p, evidenciaDe(p)));
    },
  });

  // Recuperación DURABLE: la fase viene del server (outbox = única fuente de verdad) y se
  // consulta solo con pointer vivo o un ciclo local sin cerrar. Cambiar de conversación cambia
  // la queryKey (la vieja queda inactiva); terminal (sin intento / failed) detiene el polling.
  // Review 4B: NO exige política required ni activación vigente — un pointer vivo con la config
  // cambiada a mitad de saga DEBE seguir visible/cerrable (fail-open de lectura; el server
  // rechaza la acción si corresponde). El ciclo local habilita el poll solo en sending/unknown.
  const attemptQ = useQuery({
    queryKey: ['coverage-attempt', tenantId, reqId],
    queryFn: () => getCoverageQuoteAttemptState(tenantId, reqId!),
    enabled: !!reqId && puedeVer && puedeDecidir0 && flujo.enabled && (!!pending || send.status === 'sending' || send.status === 'unknown'),
    refetchInterval: (q) => {
      const a = q.state.data?.attempt;
      if (!a || a.phase === 'failed') return false;
      return 10_000;
    },
  });
  // La fase SOLO aplica al intento durable vigente (pointer). Sin pointer no hay recuperación.
  const fase = pending ? (attemptQ.data?.attempt?.phase ?? null) : null;

  // Reconciliación del ciclo LOCAL con la fuente durable (review 4B — hallazgo ALTO): sin una
  // mutation en vuelo, un `sending` (kind in_progress de otro worker) o un `unknown` resuelto
  // por otro dispositivo JAMÁS quedan absorbentes; y un `error` contradicho por la aprobación
  // persistida se cierra (el bloque persistido informa el resultado real).
  const reqVivo = covQ.data?.request ?? null;
  const aplicadoDurable = reqVivo?.status === 'coverage_approved' && !!reqVivo.shippingQuote;
  const mutandoAhora = quoteMut.isPending;
  useEffect(() => {
    if (mutandoAhora) return;
    // 'sending' no se reconcilia: SOLO existe con la mutation en vuelo (in_progress mapea a idle).
    if (send.status === 'unknown') {
      if (attemptQ.data && attemptQ.data.attempt?.phase !== 'unknown') setSend({ status: 'idle' });
    } else if (send.status === 'error' && aplicadoDurable) {
      setSend({ status: 'idle' });
    }
  }, [send.status, mutandoAhora, attemptQ.data, aplicadoDurable]);

  /** Payload de recuperación: SIEMPRE del pointer congelado (jamás huellas vivas). */
  const payloadDelPointer = (): ShippingConfirmPayload | null => {
    const p = covQ.data?.request?.shippingQuotePending ?? null;
    if (!p || !req) return null;
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
    if (p && !quoteMut.isPending) quoteMut.mutate(p);
  };

  const puedeResolver = !!claims.role && ROLES_RESOLUCION.has(claims.role);
  // Review 4B (ALTO): las VARIABLES congelan requestId/attemptId/monto — los callbacks jamás
  // leen `req`/`covQ` vivos (un resultado tardío tras cambiar de chat se descarta: solo invalida).
  const resolver = useMutation({
    mutationFn: (vars: { requestId: string; quoteAttemptId: string; chargeGs: number; resolution: 'delivered' | 'not_delivered'; note: string }) =>
      resolveCoverageQuoteUnknown(tenantId, vars.requestId, vars.quoteAttemptId, vars.resolution, vars.note),
    onSuccess: (r, vars) => {
      invalidarQuote();
      if (vars.requestId !== reqIdRef.current) return; // el vendedor cambió de conversación
      if (r.resolved === 'delivered' && typeof r.shippingGs === 'number' && typeof r.totalGs === 'number') {
        setSend({ status: 'sent', requestId: vars.requestId, shippingGs: r.shippingGs, totalGs: r.totalGs, canonical: formatCanonicalShippingMessage(r.shippingGs) });
      } else {
        setSend({ status: 'idle' });
      }
      setNotaResolucion('');
    },
    onError: (e, vars) => {
      invalidarQuote();
      if (vars.requestId !== reqIdRef.current) return;
      const pseudoPayload: ShippingConfirmPayload = {
        requestId: vars.requestId,
        sellerDraft: formatCanonicalShippingMessage(vars.chargeGs),
        confirmedShippingGs: vars.chargeGs,
        expectedLocationFingerprint: '',
        expectedCartFingerprint: '',
      };
      setSend(mapQuoteError(e, pseudoPayload, evidenciaDe(pseudoPayload)));
    },
  });

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
          {req.cartSnapshot.subtotal?.toLocaleString('es-PY') ?? '—'}
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
          💸 Costo de envío enviado y aplicado: ₲ {formatGuaranies(quoteAplicado!.chargeGs)}
          {totalPersistido !== null
            ? <> · Total del pedido ₲ {formatGuaranies(totalPersistido)}</>
            : <> · El total no se pudo verificar: revisá el pedido en Pedidos.</>}
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
              onClick={() => aprobar.mutate()}
              disabled={ocupado}
              className="rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50"
            >
              {aprobar.isPending ? 'Aprobando…' : 'Aprobar cobertura'}
            </button>
          )}
          <button
            type="button"
            onClick={() => rechazar.mutate()}
            disabled={ocupado}
            className="rounded-lg bg-coral-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-coral-500 disabled:opacity-50"
          >
            {rechazar.isPending ? 'Rechazando…' : 'Rechazar'}
          </button>
          <button
            type="button"
            onClick={() => pedirInfo.mutate()}
            disabled={ocupado}
            className="rounded-lg border border-ink-300 px-3 py-1.5 font-semibold text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-50"
          >
            {pedirInfo.isPending ? 'Enviando…' : 'Pedir más información'}
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
            📨 Cotización de ₲ {formatGuaranies(pending.chargeGs)} preparada; podés continuar el envío.
          </p>
          <button type="button" onClick={continuarIntento} disabled={quoteMut.isPending} className="mt-1.5 rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50">
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
            ✉️ El mensaje del costo (₲ {formatGuaranies(pending.chargeGs)}) ya se envió; falta completar la aprobación (no se reenvía).
          </p>
          <button type="button" onClick={continuarIntento} disabled={quoteMut.isPending} className="mt-1.5 rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50">
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
            Intento: “{formatCanonicalShippingMessage(pending!.chargeGs)}” · Envío ₲ {formatGuaranies(pending!.chargeGs)}
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
              onClick={() => { const a = attemptQ.data?.attempt; if (notaResolucion.trim() && !resolver.isPending && a && req) resolver.mutate({ requestId: req.id, quoteAttemptId: a.quoteAttemptId, chargeGs: a.chargeGs, resolution: 'delivered', note: notaResolucion.trim() }); }}
              disabled={!notaResolucion.trim() || resolver.isPending}
              className="rounded-lg bg-mint-600 px-3 py-1.5 font-semibold text-white transition-colors hover:bg-mint-500 disabled:opacity-50"
            >
              {resolver.isPending ? 'Resolviendo…' : 'Sí llegó al cliente'}
            </button>
            <button
              type="button"
              onClick={() => { const a = attemptQ.data?.attempt; if (notaResolucion.trim() && !resolver.isPending && a && req) resolver.mutate({ requestId: req.id, quoteAttemptId: a.quoteAttemptId, chargeGs: a.chargeGs, resolution: 'not_delivered', note: notaResolucion.trim() }); }}
              disabled={!notaResolucion.trim() || resolver.isPending}
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
          onConfirm={(p) => { if (!quoteMut.isPending) quoteMut.mutate(p); }}
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
