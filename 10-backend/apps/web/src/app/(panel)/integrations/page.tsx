'use client';

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { MetaConnectionStatus, MetaAssetType } from '@vpw/shared';
import { useActiveCompany } from '@/lib/active-company';
import { useAuth } from '@/lib/auth-context';
import { getMetaConnection, listMetaAssets, connectMetaDemo, disconnectMeta, listConversionEvents, processConversions } from '@/lib/integrations';

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

export default function IntegrationsPage() {
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const { user } = useAuth();
  const qc = useQueryClient();

  const connQ = useQuery({ queryKey: ['metaConnection', tenantId], queryFn: () => getMetaConnection(tenantId!), enabled: !!tenantId });
  const assetsQ = useQuery({ queryKey: ['metaAssets', tenantId], queryFn: () => listMetaAssets(tenantId!), enabled: !!tenantId });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['metaConnection', tenantId] }); qc.invalidateQueries({ queryKey: ['metaAssets', tenantId] }); };
  const connectMut = useMutation({ mutationFn: () => connectMetaDemo(tenantId!, user?.uid ?? ''), onSuccess: invalidate });
  const disconnectMut = useMutation({ mutationFn: () => disconnectMeta(tenantId!), onSuccess: invalidate });
  const convQ = useQuery({ queryKey: ['conversionEvents', tenantId], queryFn: () => listConversionEvents(tenantId!), enabled: !!tenantId });
  const procMut = useMutation({ mutationFn: () => processConversions(tenantId!), onSuccess: () => qc.invalidateQueries({ queryKey: ['conversionEvents', tenantId] }) });

  const conn = connQ.data ?? null;
  const connected = !!conn && conn.status !== 'not_connected';
  const status = STATUS[conn?.status ?? 'not_connected'];
  const assets = useMemo(() => (assetsQ.data ?? []).slice().sort((a, b) => a.assetType.localeCompare(b.assetType)), [assetsQ.data]);

  if (companyLoading) return <div className="text-gray-400">Cargando…</div>;
  if (!tenantId) return <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">Seleccioná una empresa.</div>;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-gray-900">Integración con Meta</h1>

      <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        ⚠️ La conexión real con Meta necesita la verificación de Meta Business (en proceso). Por ahora podés
        <strong> simular la conexión</strong> para ver cómo va a funcionar el panel. El token de acceso nunca se guarda en la base — solo una referencia segura.
      </div>

      {/* Estado de conexión */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold text-gray-900">Conexión</span>
              <span className={'rounded-full px-2.5 py-0.5 text-xs font-semibold ' + status.cls}>{status.label}</span>
            </div>
            {connected && <div className="mt-1 text-sm text-gray-500">{conn!.metaBusinessName} · {conn!.scopes.length} permisos</div>}
          </div>
          <div className="flex gap-2">
            {!connected ? (
              <button onClick={() => connectMut.mutate()} disabled={connectMut.isPending} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                {connectMut.isPending ? 'Conectando…' : 'Conectar (demo)'}
              </button>
            ) : (
              <button onClick={() => disconnectMut.mutate()} disabled={disconnectMut.isPending} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                {disconnectMut.isPending ? 'Desconectando…' : 'Desconectar'}
              </button>
            )}
          </div>
        </div>
        {connected && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {conn!.scopes.map((s) => <span key={s} className="rounded bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">{s}</span>)}
          </div>
        )}
      </div>

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
