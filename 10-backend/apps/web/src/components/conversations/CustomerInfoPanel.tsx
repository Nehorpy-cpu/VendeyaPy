'use client';

/**
 * Panel de información del cliente (ADR-0021 §2 y §4).
 * Honesto por diseño: avatar de INICIALES siempre (la Cloud API no da la foto), teléfono
 * ENMASCARADO (prefijo + últimos 3), «Información no disponible» donde falte el dato, y las
 * etiquetas dicen QUÉ es cada nombre (CRM confirmado vs. perfil de WhatsApp del proveedor).
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { Customer } from '@vpw/shared';
import type { Role } from '@/lib/auth-context';
import {
  assignConversation,
  getCustomer,
  unlinkConversationClient,
} from '@/lib/conversations';
import {
  CHANNEL_ICON,
  CHANNEL_LABEL,
  conversationDisplayName,
  maskPhone,
  puedeAsignarVendedor,
  puedeVincularCliente,
} from '@/lib/conversationsUi';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { InitialsAvatar } from './InitialsAvatar';
import { LinkClientModal } from './LinkClientModal';

export interface SellerOption {
  uid: string;
  name: string;
}

const NO_DISPONIBLE = 'Información no disponible';

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{etiqueta}</dt>
      <dd className="mt-0.5 text-sm text-ink-800">{children}</dd>
    </div>
  );
}

export function CustomerInfoPanel({
  tenantId,
  customer,
  role,
  uid,
  userName,
  sellerOptions,
  onClose,
  onChanged,
  announce,
}: {
  tenantId: string;
  customer: Customer;
  role: Role | null;
  uid: string | null;
  /** Nombre legible del usuario actual (para «Asignármela a mí»). */
  userName: string | null;
  /** Vendedores vistos en la ventana de conversaciones (no hay roster server-side todavía). */
  sellerOptions: SellerOption[];
  onClose: () => void;
  onChanged: () => void;
  announce: (msg: string) => void;
}) {
  // En el PANEL DE INFO el teléfono jamás aparece completo (ADR-0021 §2): si el nombre a
  // mostrar cae al fallback de teléfono, acá se muestra ENMASCARADO también en el título.
  const nombre =
    customer.name?.trim() || customer.profileName?.trim() || maskPhone(customer.whatsappPhone);
  const conv = customer.conversation;
  const canal = conv?.channel ?? 'whatsapp';
  const [linkOpen, setLinkOpen] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  // Ficha vinculada (otro doc de customers del MISMO tenant).
  const linkedQ = useQuery({
    queryKey: ['customer', tenantId, customer.linkedClientId],
    queryFn: () => getCustomer(tenantId, customer.linkedClientId!),
    enabled: !!customer.linkedClientId,
    staleTime: 60 * 1000,
  });

  const unlinkMut = useMutation({
    mutationFn: () => unlinkConversationClient(tenantId, customer.id),
    onSuccess: () => {
      setConfirmUnlink(false);
      announce('Vínculo con la ficha de cliente quitado.');
      onChanged();
    },
  });

  // ── Asignación de vendedor ──
  const [sellerSel, setSellerSel] = useState<string>(customer.assignedSellerId ?? '');
  const opciones: SellerOption[] = [
    ...(uid ? [{ uid, name: (userName?.trim() || 'Yo') + ' (yo)' }] : []),
    ...sellerOptions.filter((s) => s.uid !== uid),
  ];
  const assignMut = useMutation({
    mutationFn: (sellerUid: string | null) => assignConversation(tenantId, customer.id, sellerUid),
    onSuccess: (r, sellerUid) => {
      announce(sellerUid ? `Conversación asignada a ${r.sellerName ?? 'un vendedor'}.` : 'Asignación quitada.');
      onChanged();
    },
  });

  const stats = customer.stats;
  const ultimoPedido = (() => {
    try {
      const d = (stats?.lastOrderAt as { toDate?: () => Date } | null)?.toDate?.();
      return d ? d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: 'numeric' }) : null;
    } catch {
      return null;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-900">Info del cliente</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar información del cliente"
          className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-600"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <InitialsAvatar id={customer.id} label={nombre} size="lg" />
          <div>
            <p className="font-semibold text-ink-900">{nombre}</p>
            <p className="text-xs text-ink-500">
              <span aria-hidden="true">{CHANNEL_ICON[canal] ?? ''} </span>
              {CHANNEL_LABEL[canal] ?? canal}
            </p>
          </div>
        </div>

        <dl className="space-y-3">
          <Dato etiqueta="Nombre (CRM)">
            {customer.name?.trim() || <span className="text-ink-400">{NO_DISPONIBLE}</span>}
          </Dato>
          <Dato etiqueta="Nombre de perfil (WhatsApp)">
            {customer.profileName?.trim() || <span className="text-ink-400">{NO_DISPONIBLE}</span>}
          </Dato>
          <Dato etiqueta="Teléfono">
            <span className="font-mono text-sm">{maskPhone(customer.whatsappPhone)}</span>
          </Dato>
          {customer.notes?.trim() && (
            <Dato etiqueta="Notas">
              <span className="whitespace-pre-wrap">{customer.notes}</span>
            </Dato>
          )}
        </dl>

        {/* ── Cliente vinculado (ficha canónica) ── */}
        <section aria-label="Cliente vinculado" className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Cliente vinculado</h3>
          {customer.linkedClientId ? (
            <div className="mt-1.5">
              {linkedQ.isLoading && <p className="text-xs text-ink-400" role="status">Cargando ficha…</p>}
              {linkedQ.isError && (
                <p className="text-xs text-coral-600" role="alert">No se pudo leer la ficha vinculada.</p>
              )}
              {linkedQ.isSuccess && (
                <p className="text-sm font-medium text-ink-900">
                  {linkedQ.data ? conversationDisplayName(linkedQ.data) : 'Ficha no encontrada'}
                </p>
              )}
              {puedeVincularCliente(role) && (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLinkOpen(true)}
                    className="rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-50"
                  >
                    Cambiar
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmUnlink(true)}
                    className="rounded-lg border border-coral-200 bg-white px-2.5 py-1 text-xs font-semibold text-coral-700 transition-colors hover:bg-coral-50"
                  >
                    Quitar vínculo
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-1.5">
              <p className="text-xs text-ink-500">Esta conversación no está vinculada a una ficha.</p>
              {puedeVincularCliente(role) && (
                <button
                  type="button"
                  onClick={() => setLinkOpen(true)}
                  className="mt-2 rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-ink-800"
                >
                  Vincular cliente
                </button>
              )}
            </div>
          )}
        </section>

        {/* ── Asignación de vendedor (solo MANAGER/OWNER/ADMIN — matriz §7) ── */}
        <section aria-label="Asignación de vendedor" className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Vendedor asignado</h3>
          <p className="mt-1 text-sm text-ink-800">
            {customer.assignedSellerId
              ? customer.assignedSellerName ?? 'Un vendedor'
              : <span className="text-ink-400">Sin asignar</span>}
          </p>
          {puedeAsignarVendedor(role) && (
            <div className="mt-2 space-y-2">
              <label className="block">
                <span className="sr-only">Elegir vendedor</span>
                <select
                  value={sellerSel}
                  onChange={(e) => setSellerSel(e.target.value)}
                  className="w-full rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs text-ink-800 focus:border-mint-500 focus:outline-none"
                >
                  <option value="">Sin asignar</option>
                  {opciones.map((s) => (
                    <option key={s.uid} value={s.uid}>{s.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => assignMut.mutate(sellerSel || null)}
                disabled={assignMut.isPending || sellerSel === (customer.assignedSellerId ?? '')}
                className="w-full rounded-lg bg-mint-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-50"
              >
                {assignMut.isPending ? 'Aplicando…' : 'Aplicar asignación'}
              </button>
              {assignMut.isError && (
                <p role="alert" className="text-xs text-coral-600">
                  {assignMut.error instanceof Error ? assignMut.error.message : 'No se pudo asignar.'}
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Métricas (si existen) ── */}
        {stats && (stats.totalOrders > 0 || stats.totalSpent > 0) ? (
          <section aria-label="Métricas del cliente" className="rounded-xl border border-ink-100 bg-ink-50/40 p-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">Historial de compras</h3>
            <dl className="mt-1.5 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-[11px] text-ink-400">Pedidos</dt>
                <dd className="font-semibold text-ink-900">{stats.totalOrders}</dd>
              </div>
              <div>
                <dt className="text-[11px] text-ink-400">Gastado</dt>
                <dd className="font-semibold text-ink-900">₲ {Math.round(stats.totalSpent).toLocaleString('es-PY')}</dd>
              </div>
              {ultimoPedido && (
                <div className="col-span-2">
                  <dt className="text-[11px] text-ink-400">Último pedido</dt>
                  <dd className="text-ink-800">{ultimoPedido}</dd>
                </div>
              )}
            </dl>
          </section>
        ) : (
          <p className="text-xs text-ink-400">Sin compras registradas todavía.</p>
        )}
      </div>

      {linkOpen && (
        <LinkClientModal
          tenantId={tenantId}
          customerId={customer.id}
          onClose={() => setLinkOpen(false)}
          onLinked={(msg) => {
            announce(msg);
            onChanged();
          }}
        />
      )}
      {confirmUnlink && (
        <ConfirmModal
          title="Quitar vínculo con la ficha"
          confirmLabel="Quitar vínculo"
          danger
          pending={unlinkMut.isPending}
          error={unlinkMut.isError ? (unlinkMut.error instanceof Error ? unlinkMut.error.message : 'No se pudo quitar el vínculo.') : null}
          onConfirm={() => unlinkMut.mutate()}
          onCancel={() => setConfirmUnlink(false)}
        >
          La conversación deja de apuntar a la ficha vinculada. No se borra ningún dato y podés
          volver a vincularla cuando quieras.
        </ConfirmModal>
      )}
    </div>
  );
}
