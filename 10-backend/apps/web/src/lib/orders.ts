/**
 * Capa de acceso a pedidos + cálculo de métricas del dashboard.
 * Métricas calculadas en el cliente sobre los pedidos leídos (volumen moderado).
 * A futuro (Track C) se precalculan con jobs para escalar barato.
 */

import { collection, getDocs, query, orderBy, where, limit as fbLimit } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import type { Order, OrderStatus, Product, OrderFinancials } from '@vpw/shared';
import { firebaseDb, firebaseFunctions } from './firebase';

const ordersCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'orders');
const orderFinancialsCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'orderFinancials');

/** Estados que cuentan como venta concretada (pago confirmado en adelante). */
const PAID_STATUSES: OrderStatus[] = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];
export const isPaidStatus = (s: OrderStatus) => PAID_STATUSES.includes(s);

// ---------------------------------------------------------------------------
// ORDER-2: ciclo de vida en la UI. ESPEJO de orders/lifecycle.ts del backend —
// acá solo decide qué botones MOSTRAR; la máquina real la hace cumplir el backend
// (callables ORDER-1) y las rules cierran cualquier write directo.
// ---------------------------------------------------------------------------

/** UNPAID: el tenant todavía puede editar datos y cancelar. */
export const UNPAID_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PENDING_VERIFICATION'];
export const canTenantEditOrder = (s: OrderStatus) => UNPAID_STATUSES.includes(s);
export const canTenantCancelOrder = (s: OrderStatus) => UNPAID_STATUSES.includes(s);
/** Siguiente paso operativo sugerido (forward-only). Terminales no avanzan. */
export const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  PAID: 'PREPARING',
  PREPARING: 'ASSIGNED',
  ASSIGNED: 'IN_TRANSIT',
  IN_TRANSIT: 'DELIVERED',
};

type CallableResult = { ok: boolean; status?: OrderStatus };

/** Cancela un pedido UNPAID (soft → CANCELLED). Motivo obligatorio (queda en auditoría). */
export async function cancelOrder(tenantId: string, orderId: string, reason: string): Promise<CallableResult> {
  const call = httpsCallable<{ tenantId: string; orderId: string; reason: string }, CallableResult>(firebaseFunctions(), 'orderCancel');
  return (await call({ tenantId, orderId, reason })).data;
}

/** Edita datos permitidos de un pedido UNPAID (notas / dirección). Items/totales: bloqueados por diseño. */
export async function updateOrderData(
  tenantId: string,
  orderId: string,
  data: { notes?: string; deliveryAddress?: Partial<Record<'street' | 'houseNumber' | 'city' | 'neighborhood' | 'reference', string>> },
): Promise<{ ok: boolean; updated: string[] }> {
  const call = httpsCallable<{ tenantId: string; orderId: string; data: unknown }, { ok: boolean; updated: string[] }>(firebaseFunctions(), 'orderUpdate');
  return (await call({ tenantId, orderId, data })).data;
}

/**
 * Avanza el estado (forward-only). `to='PAID'` = confirmar pago: el backend corre el flujo
 * COMPLETO de confirmPayment (paidAt, sesión, evento Purchase, auditoría).
 */
export async function advanceOrderStatus(tenantId: string, orderId: string, to: OrderStatus): Promise<CallableResult> {
  const call = httpsCallable<{ tenantId: string; orderId: string; to: OrderStatus }, CallableResult>(firebaseFunctions(), 'orderUpdateStatus');
  return (await call({ tenantId, orderId, to })).data;
}

/**
 * Corrección administrativa (SOLO PLATFORM_ADMIN, motivo obligatorio, audit before/after).
 * Helper preparado para el panel admin — SIN UI todavía a propósito: no exponer en la
 * página de pedidos del tenant.
 */
export async function adminCorrectOrder(
  tenantId: string,
  orderId: string,
  reason: string,
  set: { status?: OrderStatus; notes?: string },
): Promise<{ ok: boolean; corrected: string[] }> {
  const call = httpsCallable<{ tenantId: string; orderId: string; reason: string; set: unknown }, { ok: boolean; corrected: string[] }>(firebaseFunctions(), 'adminOrderCorrect');
  return (await call({ tenantId, orderId, reason, set })).data;
}

/**
 * ORDER-COMPROBANTE-VIEW-1: estado del comprobante de un pedido para la UI.
 *  - 'image'   → hay foto en nuestro Storage (se puede pedir el enlace temporal);
 *  - 'pending' → llegó comprobante pero sin imagen visible aún (media:/simulado);
 *  - 'none'    → sin comprobante.
 */
export function comprobanteEstado(o: Pick<Order, 'payment'>): 'image' | 'pending' | 'none' {
  const ref = o.payment?.comprobanteUrl ?? '';
  if (!ref) return 'none';
  return ref.startsWith('tenants/') ? 'image' : 'pending';
}

/**
 * ¿El texto es el mensaje que GENERA nuestro backend al recibir una imagen (comprobanteImage.ts)?
 * Review OCV-1: el cliente puede escribir texto libre que empiece con 📷 — solo los dos formatos
 * exactos del sistema muestran la card, y aun así la card NO afirma que sea un pago (el botón
 * real está gateado por la orden). Sniffing de texto porque Message no tiene campo estructurado.
 */
export function esMensajeImagenCliente(text: string): boolean {
  return /^📷 (Imagen recibida \(posible comprobante\)$|Comprobante: )/.test(text);
}

/** Enlace TEMPORAL para ver el comprobante (callable seguro; nunca write, nunca se persiste). */
export async function getComprobanteViewUrl(tenantId: string, orderId: string): Promise<{ url: string; expiresAt: number }> {
  const call = httpsCallable<{ tenantId: string; orderId: string }, { ok: boolean; url: string; expiresAt: number }>(
    firebaseFunctions(),
    'orderGetComprobanteViewUrl',
  );
  const r = (await call({ tenantId, orderId })).data;
  return { url: r.url, expiresAt: r.expiresAt };
}

/** Errores de callables → mensajes claros (el backend ya manda mensajes amables en español). */
export function friendlyOrderError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const code = err?.code ?? '';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para continuar.';
  if (code === 'functions/permission-denied') return err.message || 'No tenés permiso para esta acción.';
  if (code === 'functions/not-found') return 'El pedido ya no existe.';
  // failed-precondition / invalid-argument traen el mensaje claro del backend (estado, motivo, etc.).
  return err?.message || 'No se pudo completar la operación. Probá de nuevo.';
}

export async function listOrders(tenantId: string, max = 200): Promise<Order[]> {
  const snap = await getDocs(query(ordersCol(tenantId), orderBy('createdAt', 'desc'), fbLimit(max)));
  return snap.docs.map((d) => d.data() as Order);
}

/** Estados "abiertos" que le importan al vendedor en la conversación (HUMAN-HANDOFF-1).
 * Tipado contra OrderStatus para que un estado inexistente no compile (review adversarial). */
const OPEN_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PENDING_PAYMENT', 'PENDING_VERIFICATION', 'PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT',
]);

/**
 * Pedido abierto más reciente de UN cliente (para el banner del chat). Solo `where` por
 * customerId (sin orderBy → no necesita índice compuesto); filtro/orden en el cliente.
 * Límite alto a propósito: sin orderBy, Firestore recorta por ID de documento (aleatorio
 * respecto a la fecha) — con un límite chico un cliente recurrente podía dejar el pedido
 * nuevo fuera de la ventana (review adversarial).
 */
export async function getCustomerOpenOrder(tenantId: string, customerId: string): Promise<Order | null> {
  const snap = await getDocs(query(ordersCol(tenantId), where('customerId', '==', customerId), fbLimit(300)));
  const open = snap.docs
    .map((d) => d.data() as Order)
    .filter((o) => OPEN_ORDER_STATUSES.has(o.status))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  return open[0] ?? null;
}

/**
 * Finanzas privadas de pedidos (costo/ganancia), mapeadas por orderId.
 * Solo Owner/Manager pueden leerlas (reglas). El vendedor NO debe llamar esto.
 */
export async function listOrderFinancials(
  tenantId: string,
  max = 500,
): Promise<Record<string, OrderFinancials>> {
  const snap = await getDocs(query(orderFinancialsCol(tenantId), fbLimit(max)));
  const map: Record<string, OrderFinancials> = {};
  snap.docs.forEach((d) => {
    map[d.id] = d.data() as OrderFinancials;
  });
  return map;
}

export interface ProductAgg {
  productId: string;
  name: string;
  units: number;
  profit: number | null;
}

export interface DashboardMetrics {
  ventas: number;
  ingresos: number;
  costos: number | null;
  ganancia: number | null;
  margen: number | null;
  ticketPromedio: number;
  costoIncompleto: boolean; // algún pedido vendido sin costo cargado
  topVendidos: ProductAgg[];
  topRentables: ProductAgg[];
  bajoStock: { id: string; name: string; stock: number }[];
  ventasPorVendedor: { sellerId: string; ventas: number; ingresos: number }[];
}

export function computeMetrics(
  orders: Order[],
  products: Product[],
  financials: Record<string, OrderFinancials> = {},
): DashboardMetrics {
  const vendidos = orders.filter((o) => isPaidStatus(o.status));
  const ingresos = vendidos.reduce((s, o) => s + o.totals.total, 0);

  const finOf = (o: Order) => financials[o.id];
  const conCosto = vendidos.filter((o) => finOf(o)?.grossProfit != null);
  const costoIncompleto = vendidos.some((o) => !finOf(o) || finOf(o)!.grossProfit == null);
  const ganancia = conCosto.length ? conCosto.reduce((s, o) => s + (finOf(o)!.grossProfit ?? 0), 0) : null;
  const costos = conCosto.length ? conCosto.reduce((s, o) => s + (finOf(o)!.totalCost ?? 0), 0) : null;
  const margen = ganancia != null && ingresos > 0 ? (ganancia / ingresos) * 100 : null;

  // Agregar por producto: unidades (de la orden) + ganancia (cruzando con orderFinancials)
  const byProduct = new Map<string, ProductAgg>();
  for (const o of vendidos) {
    const fin = finOf(o);
    for (const it of o.items) {
      const agg = byProduct.get(it.productId) ?? { productId: it.productId, name: it.productName, units: 0, profit: 0 };
      agg.units += it.quantity;
      const lineCost = fin?.items.find((fi) => fi.productId === it.productId)?.totalCostSnapshot ?? null;
      agg.profit = agg.profit == null || lineCost == null ? null : agg.profit + (it.subtotal - lineCost);
      byProduct.set(it.productId, agg);
    }
  }
  const aggs = [...byProduct.values()];
  const topVendidos = [...aggs].sort((a, b) => b.units - a.units).slice(0, 5);
  const topRentables = [...aggs].sort((a, b) => (b.profit ?? -1) - (a.profit ?? -1)).slice(0, 5);

  const bajoStock = products
    .filter((p) => (p.inventory?.stock ?? 0) <= (p.inventory?.lowStockThreshold ?? 3))
    .map((p) => ({ id: p.id, name: p.name, stock: p.inventory?.stock ?? 0 }))
    .slice(0, 10);

  const bySeller = new Map<string, { sellerId: string; ventas: number; ingresos: number }>();
  for (const o of vendidos) {
    const key = o.sellerId ?? '(sin asignar)';
    const e = bySeller.get(key) ?? { sellerId: key, ventas: 0, ingresos: 0 };
    e.ventas += 1;
    e.ingresos += o.totals.total;
    bySeller.set(key, e);
  }

  return {
    ventas: vendidos.length,
    ingresos,
    costos,
    ganancia,
    margen,
    ticketPromedio: vendidos.length ? ingresos / vendidos.length : 0,
    costoIncompleto,
    topVendidos,
    topRentables,
    bajoStock,
    ventasPorVendedor: [...bySeller.values()].sort((a, b) => b.ingresos - a.ingresos),
  };
}
