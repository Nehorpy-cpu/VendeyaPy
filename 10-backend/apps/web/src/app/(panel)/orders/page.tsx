'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Order, OrderStatus } from '@vpw/shared';
import { useAuth } from '@/lib/auth-context';
import { useActiveCompany } from '@/lib/active-company';
import { ConfirmModal } from '@/components/ui';
import {
  listOrders, listOrderFinancials,
  canTenantEditOrder, canTenantCancelOrder, NEXT_STATUS,
  cancelOrder, updateOrderData, advanceOrderStatus, friendlyOrderError,
} from '@/lib/orders';

const gs = (n: number | null | undefined) => (n == null ? '—' : '₲ ' + Math.round(n).toLocaleString('es-PY'));

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Esperando pago',
  PENDING_VERIFICATION: 'Verificando',
  PAID: 'Pagado',
  PREPARING: 'Preparando',
  ASSIGNED: 'Asignado',
  IN_TRANSIT: 'En camino',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado',
};
const STATUS_TONE: Record<string, string> = {
  PENDING_PAYMENT: 'bg-amber-50 text-amber-700',
  PENDING_VERIFICATION: 'bg-amber-50 text-amber-700',
  PAID: 'bg-mint-50 text-mint-700',
  PREPARING: 'bg-ink-50 text-ink-600',
  ASSIGNED: 'bg-ink-50 text-ink-600',
  IN_TRANSIT: 'bg-ink-50 text-ink-600',
  DELIVERED: 'bg-mint-50 text-mint-700',
  CANCELLED: 'bg-coral-50 text-coral-700',
  REFUNDED: 'bg-coral-50 text-coral-700',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ' + (STATUS_TONE[status] ?? 'bg-ink-50 text-ink-600')}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** Motivo de cancelación (metadata que escribe orderCancel; el type Order no lo declara). */
function cancellationReason(o: Order): string | undefined {
  return (o as Order & { cancellation?: { reason?: string } }).cancellation?.reason;
}

function fecha(o: Order): string {
  try {
    const d = (o.createdAt as unknown as { toDate?: () => Date }).toDate?.();
    return d ? d.toLocaleDateString('es-PY') : '—';
  } catch {
    return '—';
  }
}

export default function OrdersPage() {
  const { claims } = useAuth();
  const { tenantId, loading: companyLoading } = useActiveCompany();
  const isSeller = claims.role === 'SELLER';
  // Cancelar/editar: solo manager+ (el backend igual lo hace cumplir; acá solo se decide qué mostrar).
  const isManager = claims.role === 'TENANT_OWNER' || claims.role === 'TENANT_MANAGER' || claims.role === 'PLATFORM_ADMIN';
  const [status, setStatus] = useState<OrderStatus | 'ALL'>('ALL');
  const [detail, setDetail] = useState<Order | null>(null);

  // ORDER-2: mutaciones por CALLABLES (nunca writes directos; rules los cierran).
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<null | 'cancel' | 'pay' | 'deliver'>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const afterMutation = (newStatus?: OrderStatus) => {
    qc.invalidateQueries({ queryKey: ['orders', tenantId] });
    if (newStatus) setDetail((d) => (d ? { ...d, status: newStatus } : d));
    setConfirming(null);
    setActionError(null);
  };
  const cancelMut = useMutation({
    mutationFn: () => cancelOrder(tenantId!, detail!.id, cancelReason.trim()),
    onSuccess: () => { afterMutation('CANCELLED'); setCancelReason(''); },
    onError: (e) => setActionError(friendlyOrderError(e)),
  });
  const advanceMut = useMutation({
    mutationFn: (to: OrderStatus) => advanceOrderStatus(tenantId!, detail!.id, to),
    onSuccess: (r) => afterMutation(r.status),
    onError: (e) => setActionError(friendlyOrderError(e)),
  });
  const notesMut = useMutation({
    mutationFn: (notes: string) => updateOrderData(tenantId!, detail!.id, { notes }),
    onSuccess: (_r, notes) => {
      qc.invalidateQueries({ queryKey: ['orders', tenantId] });
      setDetail((d) => (d ? { ...d, notes } : d));
      setEditingNotes(null);
      setActionError(null);
    },
    onError: (e) => setActionError(friendlyOrderError(e)),
  });
  const mutating = cancelMut.isPending || advanceMut.isPending || notesMut.isPending;
  const closeDetail = () => { setDetail(null); setConfirming(null); setEditingNotes(null); setActionError(null); };

  const ordersQ = useQuery({ queryKey: ['orders', tenantId], queryFn: () => listOrders(tenantId!), enabled: !!tenantId });
  // Finanzas privadas: el vendedor no puede leerlas (reglas) → no se consultan para su rol.
  const financialsQ = useQuery({
    queryKey: ['orderFinancials', tenantId],
    queryFn: () => listOrderFinancials(tenantId!),
    enabled: !!tenantId && !isSeller,
  });
  const finMap = financialsQ.data ?? {};
  const orderProfit = (orderId: string) => finMap[orderId]?.grossProfit ?? null;
  const itemProfit = (orderId: string, productId: string, subtotal: number): number | null => {
    const fi = finMap[orderId]?.items.find((x) => x.productId === productId);
    return fi?.totalCostSnapshot == null ? null : subtotal - fi.totalCostSnapshot;
  };

  const filtered = useMemo(() => {
    const list = ordersQ.data ?? [];
    return status === 'ALL' ? list : list.filter((o) => o.status === status);
  }, [ordersQ.data, status]);

  if (companyLoading) return <div className="text-sm text-ink-400">Cargando…</div>;
  if (!tenantId) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center text-sm text-ink-500">
        Seleccioná una empresa para ver sus pedidos.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Pedidos</h1>
          <p className="mt-1 text-sm text-ink-500">Seguí el estado de cada pedido{!isSeller ? ' y su ganancia' : ''}.</p>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as OrderStatus | 'ALL')}
          className="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
        >
          <option value="ALL">Todos los estados</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {ordersQ.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl border border-ink-100 bg-ink-50/60" />)}
        </div>
      )}
      {ordersQ.isError && <div className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-700">No se pudieron cargar los pedidos.</div>}
      {ordersQ.isSuccess && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-10 text-center">
          <h3 className="text-sm font-semibold text-ink-800">No hay pedidos {status !== 'ALL' ? 'en este estado' : 'todavía'}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
            {status !== 'ALL' ? 'Probá con otro filtro de estado.' : 'Cuando el bot cierre una venta, el pedido aparece acá automáticamente.'}
          </p>
        </div>
      )}

      {ordersQ.isSuccess && filtered.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-ink-100 bg-white shadow-soft">
          <table className="min-w-full text-sm">
            <thead className="border-b border-ink-100 bg-ink-50/60 text-left text-xs uppercase tracking-wide text-ink-400">
              <tr>
                <th className="px-4 py-3">Pedido</th>
                <th className="px-4 py-3">Fecha</th>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Total</th>
                {!isSeller && <th className="px-4 py-3">Ganancia</th>}
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3">Origen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {filtered.map((o) => (
                <tr key={o.id} className="hover:bg-ink-50/50">
                  <td className="px-4 py-3 font-mono text-xs text-ink-500">{o.id.slice(0, 12)}…</td>
                  <td className="px-4 py-3 text-ink-600">{fecha(o)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-500">{o.customerId.slice(0, 10)}…</td>
                  <td className="px-4 py-3 font-medium text-ink-900">{gs(o.totals.total)}</td>
                  {!isSeller && (
                    <td className="px-4 py-3">{orderProfit(o.id) == null ? <span className="text-amber-600" title="Falta costo">⚠️</span> : <span className="text-ink-700">{gs(orderProfit(o.id))}</span>}</td>
                  )}
                  <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                  <td className="px-4 py-3 text-ink-500">{o.source ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setDetail(o)} className="font-medium text-mint-700 hover:text-mint-600">Ver</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4" onClick={closeDetail}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-ink-100 bg-white p-6 shadow-float" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-ink-900">Pedido <span className="font-mono text-sm text-ink-500">{detail.id.slice(0, 12)}…</span></h2>
              <button onClick={closeDetail} className="grid h-8 w-8 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700" aria-label="Cerrar">✕</button>
            </div>
            <div className="space-y-1.5 text-sm text-ink-500">
              <p>Cliente: <span className="font-mono text-xs text-ink-700">{detail.customerId}</span></p>
              <p className="flex items-center gap-2">Estado: <StatusBadge status={detail.status} /></p>
              <p>Origen: <span className="text-ink-700">{detail.source ?? '—'}</span> · Canal: <span className="text-ink-700">{detail.channel}</span></p>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-400">
                <tr><th className="py-1">Producto</th><th>Cant.</th><th>Subtotal</th>{!isSeller && <th>Ganancia</th>}</tr>
              </thead>
              <tbody>
                {detail.items.map((it) => (
                  <tr key={it.itemId} className="border-t border-ink-50">
                    <td className="py-1.5 text-ink-800">{it.productName}</td>
                    <td className="text-ink-600">{it.quantity}</td>
                    <td className="text-ink-600">{gs(it.subtotal)}</td>
                    {!isSeller && <td className="text-ink-600">{itemProfit(detail.id, it.productId, it.subtotal) == null ? '⚠️' : gs(itemProfit(detail.id, it.productId, it.subtotal))}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 border-t border-ink-100 pt-3 text-right text-sm">
              <div className="text-ink-900">Total: <span className="font-bold">{gs(detail.totals.total)}</span></div>
              {!isSeller && <div className="text-ink-500">Ganancia: {orderProfit(detail.id) == null ? '⚠️ incompleta' : gs(orderProfit(detail.id))}</div>}
            </div>

            {/* ORDER-2: acciones según estado. Sin borrar, nunca: pagado/entregado = registro permanente. */}
            <div className="mt-5 border-t border-ink-100 pt-4">
              {detail.notes && editingNotes == null && (
                <p className="mb-3 rounded-lg bg-ink-50/60 px-3 py-2 text-sm text-ink-600">📝 {detail.notes}</p>
              )}

              {editingNotes != null ? (
                <div className="space-y-2">
                  <textarea
                    value={editingNotes}
                    onChange={(e) => setEditingNotes(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="Notas del pedido (horario de entrega, referencias…)"
                    className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30"
                  />
                  {actionError && <p className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{actionError}</p>}
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setEditingNotes(null); setActionError(null); }} className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50">Descartar</button>
                    <button onClick={() => notesMut.mutate(editingNotes)} disabled={mutating} className="rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-mint-700 disabled:opacity-60">
                      {notesMut.isPending ? 'Guardando…' : 'Guardar notas'}
                    </button>
                  </div>
                </div>
              ) : canTenantEditOrder(detail.status) ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => { setActionError(null); setConfirming('pay'); }} disabled={mutating} className="rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">
                      ✓ Confirmar pago
                    </button>
                    {isManager && (
                      <button onClick={() => { setActionError(null); setEditingNotes(detail.notes ?? ''); }} disabled={mutating} className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 disabled:opacity-60">
                        Editar notas
                      </button>
                    )}
                    {isManager && canTenantCancelOrder(detail.status) && (
                      <button onClick={() => { setActionError(null); setConfirming('cancel'); }} disabled={mutating} className="ml-auto rounded-lg border border-coral-200 px-3 py-1.5 text-sm font-medium text-coral-700 transition-colors hover:bg-coral-50 disabled:opacity-60">
                        Cancelar pedido
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-ink-400">El pedido todavía no está pagado: se puede confirmar el pago, editar notas o cancelarlo (con motivo).</p>
                </>
              ) : NEXT_STATUS[detail.status] ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => {
                        setActionError(null);
                        const next = NEXT_STATUS[detail.status]!;
                        if (next === 'DELIVERED') setConfirming('deliver');
                        else advanceMut.mutate(next);
                      }}
                      disabled={mutating}
                      className="rounded-lg bg-mint-600 px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60"
                    >
                      {advanceMut.isPending ? '…' : `→ ${STATUS_LABEL[NEXT_STATUS[detail.status]!]}`}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-ink-400">Pedido pagado: es registro permanente. Solo se avanza el estado hacia adelante (sin ediciones ni cancelación).</p>
                </>
              ) : (
                <p className="text-xs text-ink-400">
                  Registro permanente: este pedido ya no admite cambios desde el panel.
                  {detail.status === 'CANCELLED' && cancellationReason(detail) && (
                    <> · Motivo de cancelación: {cancellationReason(detail)}</>
                  )}
                </p>
              )}
              {actionError && editingNotes == null && !confirming && (
                <p className="mt-3 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{actionError}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modales de confirmación (encima del detalle) */}
      {detail && confirming === 'cancel' && (
        <ConfirmModal
          title="Cancelar pedido"
          confirmLabel={cancelMut.isPending ? 'Cancelando…' : 'Cancelar pedido'}
          cancelLabel="Volver"
          danger
          pending={cancelMut.isPending}
          error={actionError}
          onCancel={() => { setConfirming(null); setActionError(null); }}
          onConfirm={() => {
            if (cancelReason.trim().length < 3) { setActionError('Indicá el motivo de la cancelación.'); return; }
            cancelMut.mutate();
          }}
        >
          <p>El pedido pasa a <strong>Cancelado</strong> y queda en el historial (no se borra). El motivo queda en la auditoría.</p>
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder="Motivo (obligatorio) — ej: el cliente se arrepintió"
            className="mt-3 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 focus:border-coral-500 focus:outline-none focus:ring-2 focus:ring-coral-500/30"
          />
        </ConfirmModal>
      )}
      {detail && confirming === 'pay' && (
        <ConfirmModal
          title="Confirmar pago"
          confirmLabel={advanceMut.isPending ? 'Confirmando…' : 'Confirmar pago'}
          cancelLabel="Volver"
          pending={advanceMut.isPending}
          error={actionError}
          onCancel={() => { setConfirming(null); setActionError(null); }}
          onConfirm={() => advanceMut.mutate('PAID')}
        >
          <p>Vas a marcar el pedido como <strong>Pagado</strong> ({gs(detail.totals.total)}). Se registra la venta con auditoría y <strong>no se puede deshacer desde el panel</strong>.</p>
        </ConfirmModal>
      )}
      {detail && confirming === 'deliver' && (
        <ConfirmModal
          title="Marcar como entregado"
          confirmLabel={advanceMut.isPending ? 'Guardando…' : 'Marcar entregado'}
          cancelLabel="Volver"
          pending={advanceMut.isPending}
          error={actionError}
          onCancel={() => { setConfirming(null); setActionError(null); }}
          onConfirm={() => advanceMut.mutate('DELIVERED')}
        >
          <p>El pedido pasa a <strong>Entregado</strong> y queda como registro permanente del negocio.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
