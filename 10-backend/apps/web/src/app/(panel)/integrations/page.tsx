'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaConnectionStatus, MetaAssetType, WhatsappSendMode, WhatsappAutomationMode } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import {
  getMetaConnection,
  listMetaAssets,
  listConversionEvents,
  processConversions,
  connectMetaDemo,
  disconnectMeta,
  isMetaConfigured,
  isCoexistenceConfigured,
  isDemoIntegrationsAllowed,
  startMetaConnect,
  connectMeta,
  coexistenceStart,
  coexistenceConnect,
  verifyMetaChannel,
  selectMetaPhoneNumber,
  metaDisconnect,
  friendlyMetaError,
  type MetaConnectResult,
  type CoexistenceConnectResult,
} from '@/lib/integrations';
import { launchEmbeddedSignup, preloadFacebookSdk, MetaSignupError, type MetaSignupFlow, type EmbeddedSignupResult } from '@/lib/metaEmbeddedSignup';
import { getChannelConfig, setWhatsappSendMode, friendlyChannelError } from '@/lib/channels';
import { getAgentConfig } from '@/lib/agent-config';
import { resolveEntitlements, getUsage, isUnlimited } from '@/lib/entitlements';
import { SectionHeader, EmptyState, ConfirmModal, StatusBadge, type BadgeTone } from '@/components/ui';
import { WhatsappAssistedActivation } from '@/components/integrations/WhatsappAssistedActivation';
import { CoexistenceOnboardingCard } from '@/components/integrations/CoexistenceOnboardingCard';
import { CoexistenceHistoryCard } from '@/components/integrations/CoexistenceHistoryCard';

const STATUS: Record<MetaConnectionStatus, { label: string; cls: string }> = {
  not_connected: { label: 'Sin conectar', cls: 'bg-ink-50 text-ink-600' },
  connected_limited: { label: 'Conectado (limitado)', cls: 'bg-amber-50 text-amber-700' },
  pending_review: { label: 'En revisión', cls: 'bg-ink-100 text-ink-700' },
  permission_missing: { label: 'Falta un permiso', cls: 'bg-amber-50 text-amber-700' },
  // «Conexión activa» y no «Activo» a secas: una credencial válida NO autoriza al bot a contestar
  // (ADR-0017 §1). Decir «Activo» acá es lo que hacía creer que el número ya estaba trabajando.
  active: { label: 'Conexión activa', cls: 'bg-mint-50 text-mint-700' },
  error: { label: 'Error', cls: 'bg-coral-50 text-coral-700' },
  expired: { label: 'Vencido', cls: 'bg-coral-50 text-coral-700' },
  revoked: { label: 'Revocado', cls: 'bg-coral-50 text-coral-700' },
};
// Mensaje + CTA por estado (los que necesitan reconectar muestran "Reconectar").
const STATUS_HINT: Partial<Record<MetaConnectionStatus, string>> = {
  connected_limited: 'La conexión está limitada. Revisá la conexión o reconectá tu cuenta.',
  pending_review: 'Meta está revisando tu cuenta. Te avisamos cuando se active.',
  permission_missing: 'Faltan permisos de WhatsApp. Reconectá aceptando todos los permisos.',
  error: 'Hubo un problema con la conexión. Probá reconectar.',
  expired: 'La sesión de Meta venció. Reconectá tu cuenta.',
  revoked: 'Se revocó el acceso. Reconectá para volver a habilitar Meta.',
};
const RECONNECT_STATES: MetaConnectionStatus[] = ['permission_missing', 'expired', 'error', 'revoked', 'connected_limited'];

const ASSET: Record<MetaAssetType, string> = {
  business: '🏢 Negocio',
  ad_account: '📣 Cuenta de anuncios',
  facebook_page: '📘 Página de Facebook',
  instagram_account: '📸 Instagram',
  whatsapp_business_account: '💬 WhatsApp Business',
  whatsapp_phone_number: '📱 Número de WhatsApp',
  catalog: '📦 Catálogo',
  pixel: '🎯 Pixel',
};

/**
 * Cómo se muestra el permiso de automatización de UN número (ADR-0017 §1). La clave es que
 * `inactive` y «no declarado» se ven igual de callados: mostrar «Activo» un número que está en
 * observación —o que ni siquiera fue habilitado— es mentirle al dueño sobre lo que su negocio está
 * haciendo con sus clientes.
 */
const AUTOMATION_UI: Record<WhatsappAutomationMode, { label: string; tone: BadgeTone; hint: string }> = {
  inactive: {
    label: 'Sin automatizar',
    tone: 'ink',
    hint: 'El número está conectado, pero el bot todavía no responde automáticamente por él.',
  },
  shadow: {
    label: 'En observación',
    tone: 'amber',
    hint: 'Estamos mirando lo que llega a este número: el bot todavía no responde automáticamente.',
  },
  live: {
    label: 'Automatizando',
    tone: 'mint',
    hint: 'El bot responde a tus clientes por este número.',
  },
};
/** Un número sin el campo declarado se lee como el estado MÁS restrictivo, igual que en el backend. */
const automationUi = (mode: WhatsappAutomationMode | null) => AUTOMATION_UI[mode ?? 'inactive'];

type Feedback = { kind: 'ok' | 'info' | 'error'; msg: string };
const FEEDBACK_CLS: Record<Feedback['kind'], string> = {
  ok: 'bg-mint-50 text-mint-700 ring-mint-100',
  info: 'bg-ink-50 text-ink-600 ring-ink-100',
  error: 'bg-coral-50 text-coral-700 ring-coral-100',
};

/** Indicador del checklist: verde si la condición se cumple, gris si no. */
function Dot({ ok }: { ok: boolean }) {
  return <span className={'inline-block h-2 w-2 shrink-0 rounded-full ' + (ok ? 'bg-mint-500' : 'bg-ink-200')} />;
}

/**
 * El desenlace de la conexión real, DISCRIMINADO por flujo. Los dos caminos devuelven formas
 * distintas y su `status` no significa lo mismo (el de Coexistence es el de la conexión propia del
 * número, no el de `main`): sin el discriminante habría que ensanchar el tipo y el mensaje de
 * éxito se elegiría a ciegas.
 */
type ConexionRealOk =
  | { flow: 'standard'; res: MetaConnectResult }
  | { flow: 'coexistence'; res: CoexistenceConnectResult };

const btnPrimary = 'rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60';
const btnSecondary = 'rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60';
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';

export default function IntegrationsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user, claims } = useAuth();
  const qc = useQueryClient();

  const configured = isMetaConfigured();
  const coexistenceConfigured = isCoexistenceConfigured();
  // El fallback demo (endpoints dev) solo se permite en local/emulador; en prod, estados honestos.
  const demoAllowed = isDemoIntegrationsAllowed();
  // Solo owner/admin operan (conectar/verificar/seleccionar/desconectar). El backend lo reexige.
  const canOperate = claims.role === 'TENANT_OWNER' || claims.role === 'PLATFORM_ADMIN';
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [sdkListo, setSdkListo] = useState(false);

  /**
   * PRECARGA DEL SDK. El popup del Embedded Signup tiene que abrirse DENTRO del gesto del usuario:
   * si el click primero espera a que baje el SDK (y antes, encima, al callable del nonce), el
   * navegador bloquea la ventana y el flujo moría reportando «cancelaste la conexión». Precargando
   * acá, el click no espera nada.
   */
  useEffect(() => {
    if (!configured && !coexistenceConfigured) return;
    let vivo = true;
    Promise.resolve(preloadFacebookSdk(configured ? 'standard' : 'coexistence'))
      .then(() => { if (vivo) setSdkListo(true); })
      .catch(() => { if (vivo) setSdkListo(false); });
    return () => { vivo = false; };
  }, [configured, coexistenceConfigured]);

  const connQ = useQuery({ queryKey: ['metaConnection', tenantId], queryFn: () => getMetaConnection(tenantId!), enabled: !!tenantId });
  const assetsQ = useQuery({ queryKey: ['metaAssets', tenantId], queryFn: () => listMetaAssets(tenantId!), enabled: !!tenantId });
  // Estado de "respuestas reales" (W-2): modo de envío, on/off del bot (read-only) y uso de mensajes.
  const channelQ = useQuery({ queryKey: ['channelConfig', tenantId], queryFn: () => getChannelConfig(tenantId!), enabled: !!tenantId });
  const agentQ = useQuery({ queryKey: ['agentConfig', tenantId], queryFn: () => getAgentConfig(tenantId!), enabled: !!tenantId });
  const entQ = useQuery({ queryKey: ['entitlements', tenantId], queryFn: () => resolveEntitlements(tenantId!), enabled: !!tenantId });
  const usageQ = useQuery({ queryKey: ['usage', tenantId], queryFn: () => getUsage(tenantId!, entQ.data!), enabled: !!tenantId && !!entQ.data });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['metaConnection', tenantId] });
    qc.invalidateQueries({ queryKey: ['metaAssets', tenantId] });
  };

  /**
   * Conexión REAL: el popup ya está abierto cuando esto corre (lo abrió el click). Acá solo se
   * pide el nonce EN PARALELO y se espera el desenlace. Nunca tocamos el token ni logueamos el code.
   *
   * CADA FLUJO POR SU PROPIA SUPERFICIE (ADR-0017). Coexistence NO es un `mode` de `connectMeta`:
   * ese callable corre `runMetaConnect`, que guarda el token en el secreto del TENANT —pisando el
   * de `main`— y reescribe `metaAssets` con `connectionId: 'main'`, cuya limpieza borra el asset y
   * la entrada de índice del número que HOY está vendiendo. Los callables `coexistence*` dejan al
   * número real en su propia conexión `wa_{pnid}` y a `main` intacto.
   */
  const connectRealMut = useMutation({
    mutationFn: async ({ flow, signup }: { flow: MetaSignupFlow; signup: Promise<EmbeddedSignupResult> }): Promise<ConexionRealOk> => {
      if (flow === 'coexistence') {
        const noncePromise = coexistenceStart(tenantId!);
        // El error del nonce se maneja abajo; este catch evita un rechazo huérfano mientras el
        // dueño sigue en la ventana de Meta.
        noncePromise.catch(() => {});
        const { code, sessionInfo } = await signup;
        const { nonce } = await noncePromise;
        return { flow, res: await coexistenceConnect(tenantId!, { nonce, code, ...(sessionInfo ?? {}) }) };
      }
      const noncePromise = startMetaConnect(tenantId!, flow);
      noncePromise.catch(() => {});
      const { code, sessionInfo } = await signup;
      const { nonce } = await noncePromise;
      return { flow, res: await connectMeta(tenantId!, { nonce, code, mode: flow, ...(sessionInfo ?? {}) }) };
    },
    onSuccess: (r) => {
      invalidate();
      if (r.flow === 'coexistence') {
        // No se promete automatización: el número nace INACTIVO y activarlo es otra decisión.
        setFeedback({ kind: 'ok', msg: 'Conectamos tu número de WhatsApp Business. Queda inactivo: no responde automáticamente hasta que lo actives.' });
        return;
      }
      const { status } = r.res;
      setFeedback({ kind: 'ok', msg: status === 'active' ? '¡Meta conectado! Ya podés recibir mensajes de WhatsApp.' : `Conexión: ${STATUS[status]?.label ?? status}.` });
    },
    onError: (e) => {
      // Cancelar el popup NO es un error fatal; que el navegador lo bloquee, tampoco, pero se
      // explica distinto: decirle «cancelaste» a alguien que no canceló lo manda a buscar un
      // problema que no existe.
      if (e instanceof MetaSignupError && (e.reason === 'cancelled' || e.reason === 'in_progress')) {
        setFeedback({ kind: 'info', msg: e.message });
        return;
      }
      setFeedback({ kind: 'error', msg: friendlyMetaError(e) });
    },
  });
  const connectDemoMut = useMutation({
    mutationFn: () => connectMetaDemo(tenantId!, user?.uid ?? ''),
    onSuccess: () => { invalidate(); setFeedback({ kind: 'info', msg: 'Conexión simulada (demo). Configurá Meta para conectar de verdad.' }); },
    onError: (e) => setFeedback({ kind: 'error', msg: friendlyMetaError(e) }),
  });
  const verifyMut = useMutation({
    mutationFn: () => verifyMetaChannel(tenantId!),
    onSuccess: (r) => { invalidate(); setFeedback({ kind: r.ready ? 'ok' : 'info', msg: r.ready ? 'Conexión verificada: todo en orden.' : `Estado: ${STATUS[r.status]?.label ?? r.status}.` }); },
    onError: (e) => setFeedback({ kind: 'error', msg: friendlyMetaError(e) }),
  });
  const selectMut = useMutation({
    mutationFn: (phoneNumberId: string) => selectMetaPhoneNumber(tenantId!, phoneNumberId),
    onSuccess: () => { invalidate(); setFeedback({ kind: 'ok', msg: 'Número de WhatsApp actualizado.' }); },
    onError: (e) => setFeedback({ kind: 'error', msg: friendlyMetaError(e) }),
  });
  const disconnectMut = useMutation({
    mutationFn: () => (configured ? metaDisconnect(tenantId!) : disconnectMeta(tenantId!)),
    onSuccess: () => { invalidate(); setFeedback(null); },
    onError: (e) => setFeedback({ kind: 'error', msg: friendlyMetaError(e) }),
  });
  // Cambio de modo de envío de WhatsApp (W-2). 'live' lo valida el backend (Meta resoluble).
  const setModeMut = useMutation({
    mutationFn: (mode: WhatsappSendMode) => setWhatsappSendMode(tenantId!, mode),
    onSuccess: (mode) => {
      qc.invalidateQueries({ queryKey: ['channelConfig', tenantId] });
      setShowLiveModal(false);
      setFeedback({ kind: mode === 'live' ? 'ok' : 'info', msg: mode === 'live' ? 'Respuestas reales ACTIVADAS: el bot ya responde por WhatsApp.' : 'Volviste al modo demo: el bot no envía a WhatsApp real.' });
    },
    onError: (e) => { setShowLiveModal(false); setFeedback({ kind: 'error', msg: friendlyChannelError(e) }); },
  });

  // Conversions API (D6) — fuera del alcance de Meta Connect UX; se mantiene en demo.
  const convQ = useQuery({ queryKey: ['conversionEvents', tenantId], queryFn: () => listConversionEvents(tenantId!), enabled: !!tenantId });
  const procMut = useMutation({ mutationFn: () => processConversions(tenantId!), onSuccess: () => qc.invalidateQueries({ queryKey: ['conversionEvents', tenantId] }) });

  const conn = connQ.data ?? null;
  const connected = !!conn && conn.status !== 'not_connected';
  const status = STATUS[conn?.status ?? 'not_connected'];
  const hint = conn ? STATUS_HINT[conn.status] : undefined;
  const needsReconnect = connected && configured && RECONNECT_STATES.includes(conn!.status);
  const assets = useMemo(() => (assetsQ.data ?? []).slice().sort((a, b) => a.assetType.localeCompare(b.assetType)), [assetsQ.data]);
  const phoneAssets = useMemo(() => assets.filter((a) => a.assetType === 'whatsapp_phone_number'), [assets]);
  const busy = connectRealMut.isPending || connectDemoMut.isPending || verifyMut.isPending || selectMut.isPending || disconnectMut.isPending || setModeMut.isPending;
  const connecting = connectRealMut.isPending || connectDemoMut.isPending;

  // Estado de "respuestas reales" (W-2).
  const mode = channelQ.data?.whatsappSendMode ?? 'mock';
  const isLive = mode === 'live';
  const botEnabled = agentQ.data ? agentQ.data.botEnabled : null; // null mientras carga
  const selectedPhone = phoneAssets.find((a) => a.selected) ?? null;
  const metaActive = conn?.status === 'active';
  // El permiso del número (ADR-0017) es un eje APARTE del modo de envío: el envío puede estar en
  // vivo y el número seguir callado. La UI muestra los dos, sin mezclarlos.
  const numeroUi = automationUi(selectedPhone?.automationMode ?? null);
  const numeroAutomatiza = selectedPhone?.automationMode === 'live';
  // Pre-check de UI (el backend es la fuente final de verdad): live requiere conexión activa + número.
  const canGoLive = metaActive && !!selectedPhone;
  const msgItem = usageQ.data?.items.find((i) => i.metric === 'messages') ?? null;
  const fmtNum = (n: number) => n.toLocaleString('es-PY');

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  // Guard de rol EN LA RUTA (el sidebar ya la restringe, pero una URL pegada no pasa por el sidebar).
  // Es defensa en profundidad: la autorización real la reexigen los callables.
  if (!canOperate) {
    return (
      <EmptyState
        title="Solo el dueño o un administrador"
        text="La conexión con Meta y WhatsApp la gestiona el dueño de la empresa o un administrador de la plataforma."
      />
    );
  }
  if (!tenantId) return <EmptyState title="Seleccioná una empresa" text="Elegí una empresa en la barra superior para gestionar su conexión con Meta." />;

  /**
   * SE LLAMA DIRECTO EN EL CLICK. `launchEmbeddedSignup` abre el popup sincrónicamente y devuelve
   * la promesa; recién después la mutación pide el nonce. Al revés —que es como estaba— el popup se
   * abría después de dos `await` y el navegador lo bloqueaba.
   */
  const conectarReal = (flow: MetaSignupFlow) => {
    setFeedback(null);
    const signup = launchEmbeddedSignup(flow);
    signup.catch(() => {}); // el desenlace real lo maneja la mutación
    connectRealMut.mutate({ flow, signup });
  };

  const onConnect = () => {
    if (configured) { conectarReal('standard'); return; }
    if (demoAllowed) connectDemoMut.mutate(); // demo solo en local/emulador
  };

  return (
    <div className="space-y-5">
      <SectionHeader title="Integración con Meta" subtitle="Conectá Meta para recibir WhatsApp en el panel y medir tus anuncios." />

      {configured ? (
        <div className="rounded-2xl border border-ink-100 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
          Conectá tu cuenta de Meta Business para recibir mensajes de WhatsApp en el panel. El token de acceso nunca se guarda en la base — solo una referencia segura.
        </div>
      ) : demoAllowed ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Modo demo (local):</strong> configurá Meta (NEXT_PUBLIC_META_APP_ID y NEXT_PUBLIC_META_CONFIG_ID) para usar la conexión real. Por ahora podés <strong>simular la conexión</strong> para ver cómo funciona el panel. El token nunca se guarda en la base.
        </div>
      ) : (
        <div className="rounded-2xl border border-ink-100 bg-ink-50/60 px-4 py-3 text-sm text-ink-600">
          La conexión real de Meta aún no está configurada para esta plataforma. Te avisamos cuando esté disponible para tu empresa.
        </div>
      )}

      {/* El aviso se anuncia: sin aria-live, un lector de pantalla no se entera de que algo pasó. */}
      <div role="status" aria-live="polite" className={feedback ? '' : 'sr-only'}>
        {feedback && <div className={'rounded-xl px-4 py-2.5 text-sm ring-1 ring-inset ' + FEEDBACK_CLS[feedback.kind]}>{feedback.msg}</div>}
      </div>

      {/* Estado de conexión */}
      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-ink-900">Conexión</span>
              <span className={'rounded-full px-2.5 py-0.5 text-xs font-semibold ' + status.cls}>{status.label}</span>
            </div>
            {connected && <div className="mt-1 text-sm text-ink-500">{conn!.metaBusinessName} · {conn!.scopes.length} permisos</div>}
            {connected && hint && <div className="mt-1 text-xs text-ink-500">{hint}</div>}
            {connected && (
              <div className="mt-1 text-xs text-ink-500">
                Que la conexión sea válida no autoriza al bot a contestar: eso lo decide el permiso de cada número.
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {!connected && (configured || demoAllowed) && (
              <button onClick={onConnect} disabled={busy} className={btnPrimary}>
                {connecting ? 'Conectando…' : configured ? 'Conectar Meta Business' : 'Conectar (demo)'}
              </button>
            )}
            {needsReconnect && (
              <button onClick={() => conectarReal('standard')} disabled={busy} className={btnPrimary}>
                {connectRealMut.isPending ? 'Reconectando…' : 'Reconectar'}
              </button>
            )}
            {connected && configured && (
              <button onClick={() => verifyMut.mutate()} disabled={busy} className={btnSecondary}>
                {verifyMut.isPending ? 'Revisando…' : 'Revisar conexión'}
              </button>
            )}
            {connected && (configured || demoAllowed) && (
              <button onClick={() => disconnectMut.mutate()} disabled={busy} className={btnSecondary}>
                {disconnectMut.isPending ? 'Desconectando…' : 'Desconectar'}
              </button>
            )}
          </div>
        </div>
        {(configured || coexistenceConfigured) && !sdkListo && (
          <p className="mt-3 text-xs text-ink-400">Preparando la conexión con Meta… si el botón no responde, esperá unos segundos y probá de nuevo.</p>
        )}
        {connected && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {conn!.scopes.map((s) => <span key={s} className="rounded bg-ink-50 px-2 py-0.5 text-[10px] text-ink-500">{s}</span>)}
          </div>
        )}
      </div>

      {/* Coexistence (ADR-0017): el número que el negocio YA usa con sus clientes. */}
      <CoexistenceOnboardingCard
        configured={coexistenceConfigured}
        canOperate={canOperate}
        pending={connectRealMut.isPending}
        onConfirm={() => conectarReal('coexistence')}
      />

      {/* El flujo humano del historial (ADR-0017 §5), UNO por número de Coexistence conectado.
          El PNID sale de los assets del tenant que esta página ya listó — jamás de un input — y
          el backend lo re-verifica contra la conexión `wa_{pnid}` propia. */}
      {(assetsQ.data ?? [])
        .filter((a) => a.assetType === 'whatsapp_phone_number' && (a.connectionId ?? '').startsWith('wa_'))
        .map((a) => (
          <CoexistenceHistoryCard key={a.externalId} tenantId={tenantId!} phoneNumberId={a.externalId} canOperate={canOperate} />
        ))}

      {/* Activación asistida de WhatsApp (WM-2): cuando el Embedded Signup no está configurado, el owner
          pide ayuda al equipo. No activa 'live' (eso sigue siendo exclusivo de channelConfigUpdate). */}
      {!configured && <WhatsappAssistedActivation tenantId={tenantId} canOperate={canOperate} connStatus={conn?.status ?? null} />}

      {/* Respuestas reales por WhatsApp (W-2) */}
      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-ink-900">Respuestas reales por WhatsApp</span>
            <span className={'rounded-full px-2.5 py-0.5 text-xs font-semibold ' + (isLive && numeroAutomatiza ? 'bg-mint-50 text-mint-700' : isLive ? 'bg-amber-50 text-amber-700' : 'bg-ink-50 text-ink-600')}>
              {isLive ? (numeroAutomatiza ? 'En vivo' : 'En vivo, con el número en pausa') : 'Demo (mock)'}
            </span>
          </div>
          <div className="flex gap-2">
            {!isLive ? (
              <button
                onClick={() => setShowLiveModal(true)}
                disabled={busy || !canGoLive}
                title={!canGoLive ? 'Conectá Meta y elegí un número de WhatsApp primero.' : undefined}
                className={btnPrimary}
              >
                Activar respuestas reales
              </button>
            ) : (
              <button onClick={() => setModeMut.mutate('mock')} disabled={busy} className={btnSecondary}>
                {setModeMut.isPending && setModeMut.variables === 'mock' ? 'Volviendo…' : 'Volver a demo'}
              </button>
            )}
          </div>
        </div>

        {!isLive && !canGoLive && (
          <p className="mt-2 text-xs text-amber-700">
            {!metaActive ? 'Conectá Meta y verificá la conexión' : 'Elegí un número de WhatsApp'} antes de activar respuestas reales.
          </p>
        )}

        {/* Checklist de estado */}
        <ul className="mt-4 space-y-2 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-700"><Dot ok={!!metaActive} /> Meta conectado</span>
            <span className="text-ink-600">{metaActive ? 'Sí' : 'No'}</span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-700"><Dot ok={!!selectedPhone} /> Número de WhatsApp</span>
            <span className="truncate text-ink-600">{selectedPhone ? selectedPhone.name : 'Sin seleccionar'}</span>
          </li>
          {/* El permiso del número: lo que decide de verdad si el bot habla por él. */}
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-700"><Dot ok={numeroAutomatiza} /> Automatización del número</span>
            <span className="text-ink-600">
              {selectedPhone ? <StatusBadge tone={numeroUi.tone}>{numeroUi.label}</StatusBadge> : '—'}
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-700"><Dot ok={isLive} /> Modo de envío</span>
            <span className="text-ink-600">{isLive ? 'En vivo' : 'Demo (mock)'}</span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-700"><Dot ok={botEnabled === true} /> Bot encendido</span>
            <span className="flex items-center gap-2 text-ink-600">
              {botEnabled === null ? '—' : botEnabled ? 'Sí' : 'No'}
              <Link href="/agent" className="text-xs text-mint-700 hover:text-mint-600">Config. del agente</Link>
            </span>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-ink-700"><span className="inline-block h-2 w-2 shrink-0 rounded-full bg-ink-200" /> Mensajes del mes</span>
            <span className="text-ink-600">{msgItem ? (isUnlimited(msgItem.limit) ? `${fmtNum(msgItem.used)} / ilimitado` : `${fmtNum(msgItem.used)} / ${fmtNum(msgItem.limit)}`) : '—'}</span>
          </li>
        </ul>

        {selectedPhone && !numeroAutomatiza && <p className="mt-3 text-xs text-amber-700">{numeroUi.hint}</p>}
      </div>

      {/* Selección de número de WhatsApp (si hay más de uno) */}
      {connected && phoneAssets.length > 1 && (
        <div className={card}>
          <h2 className="mb-2 text-sm font-semibold text-ink-700">Número de WhatsApp activo</h2>
          <p className="mb-3 text-xs text-ink-500">Elegí con qué número va a operar el bot. El permiso de automatización de cada número se decide aparte.</p>
          <div className="space-y-2">
            {phoneAssets.map((a) => {
              const ui = automationUi(a.automationMode);
              return (
                <button
                  key={a.id}
                  onClick={() => selectMut.mutate(a.id)}
                  disabled={busy || a.selected}
                  className={'flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors disabled:cursor-default ' + (a.selected ? 'border-mint-500 bg-mint-50 text-mint-700' : 'border-ink-200 hover:bg-ink-50')}
                >
                  <span className="font-medium">📱 {a.name}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge tone={ui.tone}>{ui.label}</StatusBadge>
                    {a.selected ? (
                      <span className="text-[10px] font-medium uppercase tracking-wide">en uso</span>
                    ) : (
                      <span className="text-xs text-mint-700">{selectMut.isPending && selectMut.variables === a.id ? 'Seleccionando…' : 'Usar este'}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Activos conectados — en prod no se muestran activos demo (solo conexión real). */}
      {connected && (configured || demoAllowed) && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Activos conectados ({assets.length}){!configured && ' · demo'}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {assets.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-xl border border-ink-100 bg-white p-3 shadow-soft">
                <div>
                  <div className="text-sm font-medium text-ink-800">{ASSET[a.assetType] ?? a.assetType}</div>
                  <div className="text-xs text-ink-500">{a.name}</div>
                </div>
                {a.selected && <span className="rounded-full bg-mint-50 px-2 py-0.5 text-[10px] font-semibold text-mint-700">en uso</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversions API (D6) */}
      {connected && (
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-ink-900">Conversions API</div>
              <div className="mt-1 text-sm text-ink-500">{convQ.data?.filter((e) => e.sendStatus === 'sent').length ?? 0} eventos enviados a Meta (server-side)</div>
            </div>
            {demoAllowed ? (
              <button onClick={() => procMut.mutate()} disabled={procMut.isPending} className={btnSecondary}>{procMut.isPending ? 'Procesando…' : 'Procesar eventos (demo)'}</button>
            ) : (
              <span className="inline-flex items-center rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-400">Próximamente</span>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-400">Manda las ventas y conversiones directo a Meta (sin depender de cookies del navegador), para que los anuncios optimicen mejor y midan las ventas reales.</p>
        </div>
      )}

      {/* Modal de confirmación para activar respuestas reales (W-2) */}
      {showLiveModal && (
        <ConfirmModal
          title="Activar respuestas reales"
          confirmLabel="Sí, activar respuestas reales"
          onConfirm={() => setModeMut.mutate('live')}
          onCancel={() => setShowLiveModal(false)}
          pending={setModeMut.isPending}
        >
          El bot <strong>empezará a responder a clientes reales por WhatsApp</strong>
          {selectedPhone ? <> con el número <strong>{selectedPhone.name}</strong></> : null}. Asegurate de tener tu catálogo y tus datos de pago listos.
        </ConfirmModal>
      )}
    </div>
  );
}
