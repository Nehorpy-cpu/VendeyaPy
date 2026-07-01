'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setManualWhatsappConnection, friendlyWhatsappError, type ManualWhatsappConnResult } from '@/lib/whatsapp-activation';

/**
 * Form del PLATFORM_ADMIN para cargar manualmente la conexión WhatsApp de una empresa (WM-1).
 * SEGURIDAD: el access token vive SOLO en estado transitorio del componente — nunca se guarda en
 * localStorage, nunca se loguea, y se limpia al enviar y al desmontar. La validación real la hace el
 * backend (adminSetManualWhatsappConnection); acá solo chequeos mínimos para dar feedback rápido.
 */
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';
const field = 'w-full rounded-xl border border-ink-200 px-3 py-2 text-sm focus:border-mint-400 focus:outline-none';
const label = 'text-xs font-medium text-ink-600';

const STATUS_MSG: Record<string, { tone: 'ok' | 'info' | 'error'; msg: string }> = {
  active: { tone: 'ok', msg: 'Conexión activa. El número ya resuelve y el token validó en Meta.' },
  pending_review: { tone: 'info', msg: 'Conexión cargada. Quedó en revisión (verificando con Meta).' },
  connected_limited: { tone: 'info', msg: 'Conexión cargada con limitaciones. Revisá los permisos.' },
  permission_missing: { tone: 'error', msg: 'Faltan permisos en el token (whatsapp_business_messaging/management).' },
  expired: { tone: 'error', msg: 'El token está vencido. Pedí uno nuevo y volvé a cargar.' },
  revoked: { tone: 'error', msg: 'El acceso fue revocado. Pedí un token nuevo.' },
  error: { tone: 'error', msg: 'No se pudo verificar. Revisá los datos y volvé a cargar.' },
};
const TONE_CLS: Record<'ok' | 'info' | 'error', string> = {
  ok: 'bg-mint-50 text-mint-700 ring-mint-100',
  info: 'bg-ink-50 text-ink-600 ring-ink-100',
  error: 'bg-coral-50 text-coral-700 ring-coral-100',
};

export function ManualWhatsappConnectForm({
  initial,
  onDone,
}: {
  initial?: { tenantId?: string; requestId?: string; businessName?: string };
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const requestId = initial?.requestId;
  const [tenantId, setTenantId] = useState(initial?.tenantId ?? '');
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState('');
  const [businessId, setBusinessId] = useState('');
  const [businessName, setBusinessName] = useState(initial?.businessName ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [expiry, setExpiry] = useState(''); // yyyy-mm-dd (opcional)
  const [result, setResult] = useState<ManualWhatsappConnResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // El token es sensible: se limpia al desmontar (no queda en memoria del componente).
  useEffect(() => () => setAccessToken(''), []);

  const mut = useMutation({
    mutationFn: () => {
      const tid = tenantId.trim();
      if (!tid) throw new Error('Falta el tenantId (empresa).');
      if (!wabaId.trim()) throw new Error('Falta el WABA ID.');
      if (!/^[0-9]{5,20}$/.test(phoneNumberId.trim())) throw new Error('El Phone Number ID debe ser el id numérico de Meta (no el número con +).');
      if (!displayPhoneNumber.trim()) throw new Error('Falta el número visible (display phone number).');
      if (!accessToken.trim()) throw new Error('Falta el access token.');
      const expMs = expiry ? new Date(expiry).getTime() : NaN;
      return setManualWhatsappConnection({
        tenantId: tid,
        wabaId: wabaId.trim(),
        phoneNumberId: phoneNumberId.trim(),
        displayPhoneNumber: displayPhoneNumber.trim(),
        businessId: businessId.trim() || undefined,
        businessName: businessName.trim() || undefined,
        accessToken,
        tokenExpiresAt: Number.isFinite(expMs) && expMs > 0 ? expMs : undefined,
        requestId,
      });
    },
    onSuccess: (r) => {
      setResult(r);
      setAccessToken(''); // nunca dejamos el token en memoria tras enviarlo
      qc.invalidateQueries({ queryKey: ['pendingWhatsappActivations'] });
      qc.invalidateQueries({ queryKey: ['metaConnection', tenantId.trim()] });
      onDone?.();
    },
    onError: (e) => setErr(e instanceof Error ? e.message : friendlyWhatsappError(e)),
  });

  const resultInfo = result ? (STATUS_MSG[result.status] ?? { tone: 'info' as const, msg: `Estado: ${result.status}` }) : null;

  return (
    <section className={card}>
      <h2 className="text-base font-bold text-ink-900">Cargar conexión manual {requestId && <span className="text-ink-400">(solicitud {requestId.slice(0, 6)}…)</span>}</h2>
      <p className="mt-1 text-xs text-ink-500">
        Datos del WhatsApp Business de la empresa. El <strong>Phone Number ID</strong> es el id numérico de Meta (no el número con +).
        El token se envía cifrado al servidor y <strong>no se guarda ni se muestra</strong> acá.
      </p>

      <form
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => { e.preventDefault(); setErr(null); setResult(null); mut.mutate(); }}
      >
        <div className="sm:col-span-1">
          <label className={label}>Empresa (tenantId) *</label>
          <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="tenantId" className={field} autoComplete="off" />
        </div>
        <div className="sm:col-span-1">
          <label className={label}>Nombre de la empresa</label>
          <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Opcional" className={field} autoComplete="off" />
        </div>
        <div className="sm:col-span-1">
          <label className={label}>WABA ID *</label>
          <input value={wabaId} onChange={(e) => setWabaId(e.target.value)} placeholder="WhatsApp Business Account ID" className={field} autoComplete="off" />
        </div>
        <div className="sm:col-span-1">
          <label className={label}>Business ID</label>
          <input value={businessId} onChange={(e) => setBusinessId(e.target.value)} placeholder="Opcional" className={field} autoComplete="off" />
        </div>
        <div className="sm:col-span-1">
          <label className={label}>Phone Number ID * <span className="text-ink-400">(id numérico)</span></label>
          <input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="109876543210987" inputMode="numeric" className={field} autoComplete="off" />
        </div>
        <div className="sm:col-span-1">
          <label className={label}>Número visible *</label>
          <input value={displayPhoneNumber} onChange={(e) => setDisplayPhoneNumber(e.target.value)} placeholder="+595 99 123 4567" className={field} autoComplete="off" />
        </div>
        <div className="sm:col-span-2">
          <label className={label}>Access token *</label>
          <textarea
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder="Token de acceso de WhatsApp (System User de larga duración)"
            className={field + ' min-h-[72px] font-mono text-xs'}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-[11px] text-ink-400">Se envía cifrado al servidor. No se guarda en la base ni se muestra después de cargar.</p>
        </div>
        <div className="sm:col-span-1">
          <label className={label}>Vencimiento del token</label>
          <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={field} />
          <p className="mt-1 text-[11px] text-ink-400">Dejalo vacío si el token no expira.</p>
        </div>

        <div className="sm:col-span-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={mut.isPending}
            className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
          >
            {mut.isPending ? 'Cargando…' : 'Cargar conexión'}
          </button>
          {requestId && <span className="text-xs text-ink-400">Al cargar, la solicitud queda marcada como completada.</span>}
        </div>
      </form>

      {err && <p aria-live="polite" className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{err}</p>}
      {resultInfo && (
        <div className={'mt-3 rounded-xl px-4 py-2.5 text-sm ring-1 ring-inset ' + TONE_CLS[resultInfo.tone]}>
          {resultInfo.msg}{result?.phoneNumber ? <> · {result.phoneNumber}</> : null}
        </div>
      )}
    </section>
  );
}
