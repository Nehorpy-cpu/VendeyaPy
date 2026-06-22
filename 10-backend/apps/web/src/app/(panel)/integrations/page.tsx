'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaConnectionStatus, MetaAssetType } from '@vpw/shared';
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
  startMetaConnect,
  connectMeta,
  verifyMetaChannel,
  selectMetaPhoneNumber,
  metaDisconnect,
  friendlyMetaError,
} from '@/lib/integrations';
import { launchEmbeddedSignup, MetaSignupError } from '@/lib/metaEmbeddedSignup';

const STATUS: Record<MetaConnectionStatus, { label: string; cls: string }> = {
  not_connected: { label: 'Sin conectar', cls: 'bg-gray-100 text-gray-600' },
  connected_limited: { label: 'Conectado (limitado)', cls: 'bg-amber-100 text-amber-700' },
  pending_review: { label: 'En revisión', cls: 'bg-blue-100 text-blue-700' },
  permission_missing: { label: 'Falta un permiso', cls: 'bg-amber-100 text-amber-700' },
  active: { label: 'Activo', cls: 'bg-brand-100 text-brand-700' },
  error: { label: 'Error', cls: 'bg-red-100 text-red-700' },
  expired: { label: 'Vencido', cls: 'bg-red-100 text-red-700' },
  revoked: { label: 'Revocado', cls: 'bg-red-100 text-red-700' },
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

type Feedback = { kind: 'ok' | 'info' | 'error'; msg: string };
const FEEDBACK_CLS: Record<Feedback['kind'], string> = {
  ok: 'bg-brand-50 text-brand-700 ring-brand-100',
  info: 'bg-blue-50 text-blue-700 ring-blue-100',
  error: 'bg-red-50 text-red-700 ring-red-100',
};

export default function IntegrationsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user, claims } = useAuth();
  const qc = useQueryClient();

  const configured = isMetaConfigured();
  // Solo owner/admin operan (conectar/verificar/seleccionar/desconectar). El backend lo reexige.
  const canOperate = claims.role === 'TENANT_OWNER' || claims.role === 'PLATFORM_ADMIN';
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const connQ = useQuery({ queryKey: ['metaConnection', tenantId], queryFn: () => getMetaConnection(tenantId!), enabled: !!tenantId });
  const assetsQ = useQuery({ queryKey: ['metaAssets', tenantId], queryFn: () => listMetaAssets(tenantId!), enabled: !!tenantId });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['metaConnection', tenantId] });
    qc.invalidateQueries({ queryKey: ['metaAssets', tenantId] });
  };

  // Conexión REAL: nonce → Embedded Signup → connectMeta. Nunca tocamos el token ni logueamos el code.
  const connectRealMut = useMutation({
    mutationFn: async () => {
      const { nonce } = await startMetaConnect(tenantId!);
      const { code, sessionInfo } = await launchEmbeddedSignup();
      return connectMeta(tenantId!, { nonce, code, ...(sessionInfo ?? {}) });
    },
    onSuccess: (res) => {
      invalidate();
      setFeedback({ kind: 'ok', msg: res.status === 'active' ? '¡Meta conectado! Ya podés recibir mensajes de WhatsApp.' : `Conexión: ${STATUS[res.status]?.label ?? res.status}.` });
    },
    onError: (e) => {
      // Cancelar el popup NO es un error fatal.
      if (e instanceof MetaSignupError && e.reason === 'cancelled') { setFeedback({ kind: 'info', msg: e.message }); return; }
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
  const busy = connectRealMut.isPending || connectDemoMut.isPending || verifyMut.isPending || selectMut.isPending || disconnectMut.isPending;
  const connecting = connectRealMut.isPending || connectDemoMut.isPending;

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  const onConnect = () => (configured ? connectRealMut.mutate() : connectDemoMut.mutate());

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-gray-900">Integración con Meta</h1>

      {configured ? (
        <div className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600">
          Conectá tu cuenta de Meta Business para recibir mensajes de WhatsApp en el panel. El token de acceso nunca se guarda en la base — solo una referencia segura.
        </div>
      ) : (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <strong>Modo demo:</strong> configurá Meta (NEXT_PUBLIC_META_APP_ID y NEXT_PUBLIC_META_CONFIG_ID) para usar la conexión real. Por ahora podés <strong>simular la conexión</strong> para ver cómo funciona el panel. El token nunca se guarda en la base.
        </div>
      )}

      {feedback && (
        <div className={'rounded-xl px-4 py-2.5 text-sm ring-1 ring-inset ' + FEEDBACK_CLS[feedback.kind]}>{feedback.msg}</div>
      )}

      {/* Estado de conexión */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-gray-900">Conexión</span>
              <span className={'rounded-full px-2.5 py-0.5 text-xs font-semibold ' + status.cls}>{status.label}</span>
            </div>
            {connected && <div className="mt-1 text-sm text-gray-500">{conn!.metaBusinessName} · {conn!.scopes.length} permisos</div>}
            {connected && hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
          </div>

          <div className="flex flex-wrap gap-2">
            {!canOperate ? (
              <span className="text-xs text-gray-400">Solo el dueño o un administrador pueden gestionar la conexión.</span>
            ) : (
              <>
                {!connected && (
                  <button onClick={onConnect} disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                    {connecting ? 'Conectando…' : configured ? 'Conectar Meta Business' : 'Conectar (demo)'}
                  </button>
                )}
                {needsReconnect && (
                  <button onClick={() => connectRealMut.mutate()} disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                    {connectRealMut.isPending ? 'Reconectando…' : 'Reconectar'}
                  </button>
                )}
                {connected && configured && (
                  <button onClick={() => verifyMut.mutate()} disabled={busy} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                    {verifyMut.isPending ? 'Revisando…' : 'Revisar conexión'}
                  </button>
                )}
                {connected && (
                  <button onClick={() => disconnectMut.mutate()} disabled={busy} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                    {disconnectMut.isPending ? 'Desconectando…' : 'Desconectar'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {connected && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {conn!.scopes.map((s) => <span key={s} className="rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">{s}</span>)}
          </div>
        )}
      </div>

      {/* Selección de número de WhatsApp (si hay más de uno) */}
      {connected && canOperate && phoneAssets.length > 1 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Número de WhatsApp activo</h2>
          <p className="mb-3 text-xs text-gray-500">Elegí con qué número va a operar el bot.</p>
          <div className="space-y-2">
            {phoneAssets.map((a) => (
              <button
                key={a.id}
                onClick={() => selectMut.mutate(a.id)}
                disabled={busy || a.selected}
                className={'flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition-colors disabled:cursor-default ' + (a.selected ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-gray-200 hover:bg-gray-50')}
              >
                <span className="font-medium">📱 {a.name}</span>
                {a.selected ? (
                  <span className="text-[10px] font-medium uppercase tracking-wide">en uso</span>
                ) : (
                  <span className="text-xs text-brand-600">{selectMut.isPending && selectMut.variables === a.id ? 'Seleccionando…' : 'Usar este'}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Activos conectados */}
      {connected && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Activos conectados ({assets.length})</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {assets.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                <div>
                  <div className="text-sm font-medium text-gray-800">{ASSET[a.assetType] ?? a.assetType}</div>
                  <div className="text-xs text-gray-500">{a.name}</div>
                </div>
                {a.selected && <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-medium text-brand-700">en uso</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conversions API (D6) */}
      {connected && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-gray-900">Conversions API</div>
              <div className="mt-1 text-sm text-gray-500">{convQ.data?.filter((e) => e.sendStatus === 'sent').length ?? 0} eventos enviados a Meta (server-side)</div>
            </div>
            <button onClick={() => procMut.mutate()} disabled={procMut.isPending} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">{procMut.isPending ? 'Procesando…' : 'Procesar eventos (demo)'}</button>
          </div>
          <p className="mt-2 text-xs text-gray-400">Manda las ventas y conversiones directo a Meta (sin depender de cookies del navegador), para que los anuncios optimicen mejor y midan las ventas reales.</p>
        </div>
      )}
    </div>
  );
}
