'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ConfirmModal } from '@/components/ui';
import { listTenantWhatsappNumbers, adminDeactivateWhatsappNumber, friendlyWhatsappError, type TenantWhatsappNumber } from '@/lib/whatsapp-activation';
import { ManualWhatsappConnectForm } from './ManualWhatsappConnectForm';

/**
 * MULTI-NUMBER-1 — Números de WhatsApp de una empresa (solo PLATFORM_ADMIN; la página ya gatea).
 * Lista los números (principal + adicionales), permite agregar uno adicional (callable
 * adminAddWhatsappNumber, respeta el límite del plan) y desactivar adicionales
 * (adminDeactivateWhatsappNumber: deja de rutear, historial intacto). El principal se
 * gestiona con el form de reemplazo de arriba.
 */
const card = 'rounded-2xl border border-ink-100 bg-white p-5 shadow-soft';

export function TenantWhatsappNumbers() {
  const qc = useQueryClient();
  const [tenantId, setTenantId] = useState('');
  const [loadedTenant, setLoadedTenant] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deactivating, setDeactivating] = useState<TenantWhatsappNumber | null>(null);
  const [error, setError] = useState<string | null>(null);

  const numbersQ = useQuery({
    queryKey: ['tenantWhatsappNumbers', loadedTenant],
    queryFn: () => listTenantWhatsappNumbers(loadedTenant!),
    enabled: !!loadedTenant,
  });

  const deactivateMut = useMutation({
    mutationFn: (n: TenantWhatsappNumber) => adminDeactivateWhatsappNumber(loadedTenant!, n.phoneNumberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenantWhatsappNumbers', loadedTenant] });
      setDeactivating(null);
      setError(null);
    },
    onError: (e) => setError(friendlyWhatsappError(e)),
  });

  return (
    <section className={card}>
      <h2 className="text-base font-bold text-ink-900">Números de WhatsApp de la empresa</h2>
      <p className="mt-1 text-xs text-ink-500">
        Multi-número: el <strong>principal</strong> responde por default; cada adicional rutea y responde por sí mismo.
        Desactivar un adicional lo saca del ruteo <strong>sin borrar el historial</strong> de conversaciones.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="tenantId (empresa)"
          className="rounded-xl border border-ink-200 px-3 py-2 text-sm focus:border-mint-400 focus:outline-none"
          autoComplete="off"
        />
        <button
          onClick={() => { setLoadedTenant(tenantId.trim() || null); setAdding(false); setError(null); }}
          disabled={!tenantId.trim()}
          className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
        >
          Ver números
        </button>
        {loadedTenant && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded-lg bg-mint-600 px-3 py-2 text-sm font-semibold text-white hover:bg-mint-700"
          >
            {adding ? 'Cerrar formulario' : '+ Agregar número adicional'}
          </button>
        )}
      </div>

      {loadedTenant && numbersQ.isLoading && <p className="mt-3 text-sm text-ink-400">Cargando…</p>}
      {loadedTenant && numbersQ.isError && <p className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">No se pudieron leer los números (¿tenantId correcto?).</p>}
      {loadedTenant && numbersQ.isSuccess && (
        numbersQ.data.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">Esta empresa no tiene números conectados.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-50 rounded-xl border border-ink-100">
            {numbersQ.data.map((n) => (
              <li key={n.phoneNumberId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-ink-800">{n.displayPhoneNumber}</span>
                <span className="font-mono text-xs text-ink-400">{n.phoneNumberId}</span>
                {n.isDefault && <span className="rounded-full bg-mint-50 px-2 py-0.5 text-xs font-semibold text-mint-700">Principal</span>}
                <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + (n.status === 'active' ? 'bg-ink-50 text-ink-600' : 'bg-coral-50 text-coral-700')}>
                  {n.status === 'active' ? 'Activo' : 'Inactivo'}
                </span>
                {!n.isDefault && n.status === 'active' && (
                  <button
                    onClick={() => { setError(null); setDeactivating(n); }}
                    className="ml-auto rounded-lg border border-coral-200 px-2.5 py-1 text-xs font-medium text-coral-700 hover:bg-coral-50"
                  >
                    Desactivar
                  </button>
                )}
              </li>
            ))}
          </ul>
        )
      )}
      {error && !deactivating && <p className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{error}</p>}

      {adding && loadedTenant && (
        <div className="mt-4">
          <ManualWhatsappConnectForm
            key={`add-${loadedTenant}`}
            mode="add"
            initial={{ tenantId: loadedTenant }}
            onDone={() => qc.invalidateQueries({ queryKey: ['tenantWhatsappNumbers', loadedTenant] })}
          />
        </div>
      )}

      {deactivating && (
        <ConfirmModal
          title="Desactivar número"
          confirmLabel={deactivateMut.isPending ? 'Desactivando…' : 'Desactivar'}
          cancelLabel="Volver"
          danger
          pending={deactivateMut.isPending}
          error={error}
          onCancel={() => { setDeactivating(null); setError(null); }}
          onConfirm={() => deactivateMut.mutate(deactivating)}
        >
          <p>
            <strong>{deactivating.displayPhoneNumber}</strong> deja de recibir y responder mensajes (sale del ruteo)
            y su token se elimina. <strong>El historial de conversaciones no se borra.</strong> Queda auditado.
          </p>
        </ConfirmModal>
      )}
    </section>
  );
}
