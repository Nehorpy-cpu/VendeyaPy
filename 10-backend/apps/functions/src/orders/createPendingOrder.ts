/**
 * orders/createPendingOrder.ts — Crea una orden pendiente de pago (F6.1)
 * ======================================================================
 * Toma el carrito de la sesión y crea una Order en Firestore con estado
 * PENDING_PAYMENT. El cobro es por TRANSFERENCIA (ver checkoutConfig): el cliente
 * transfiere y manda comprobante; un vendedor confirma (F6b). Crear la orden NO
 * cobra dinero: persiste el estado del checkout antes del pago (innegociable de
 * backend: persistir antes de operaciones importantes).
 */

import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import { newOrderId, newOrderItemId, computeOrderTotals } from '@vpw/shared';
import type { Order, OrderItem, OrderFinancials, OrderFinancialsItem, Address, OrderCartInput } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { getProductCost } from '../catalog/financials.js';
import { CAMPOS_CRITICOS, driftGuardCableado, leerDeriva, resumenSaneado, type VeredictoDeriva } from '../catalog/driftGuard.js';

/**
 * El carrito contiene productos que ya no se pueden vender (desactivados o sin stock desde
 * que se armó). El motor la captura y responde con honestidad, sin crear el pedido.
 */
export class ProductNoVendibleError extends Error {
  constructor(readonly productNames: string[]) {
    super(`Productos no disponibles: ${productNames.join(', ')}`);
    this.name = 'ProductNoVendibleError';
  }
}

/**
 * ADR-0015 §8: el precio / la disponibilidad / el stock PÚBLICO de algún producto del carrito los
 * gobierna una fuente externa que hoy publica otra cosa, así que no podemos confirmarlos.
 *
 * Extiende `ProductNoVendibleError` A PROPÓSITO: para todo lo que ya sabe frenar un checkout con
 * productos que hoy no se pueden vender solos —el motor y el worker de reanudación de cobertura,
 * que lo deja `held_by_seller` y avisa— este es exactamente el mismo caso, y no queremos una
 * segunda lógica de pedidos. Quien necesite distinguirlo (el motor, para derivar con la razón
 * estructurada correcta) lo chequea PRIMERO por ser la subclase.
 */
export class ProductoConDerivaCriticaError extends ProductNoVendibleError {
  constructor(readonly veredicto: VeredictoDeriva) {
    super(veredicto.bloqueantes.map((b) => b.productName));
    this.name = 'ProductoConDerivaCriticaError';
    this.message = `Deriva crítica del dato público en ${veredicto.bloqueantes.length} producto(s)`;
  }
}

/**
 * ADR-0015 §8 — freno sobre una orden YA CREADA, la que se va a cobrar. Lanza
 * `ProductoConDerivaCriticaError` si el dato público de algún ítem hoy no se puede afirmar. NO
 * escribe ni modifica nada: la orden existente es intocable (COVERAGE-1D).
 *
 * Vive acá, y no copiado en cada rama que reusa un pedido, para que exista UNA sola definición de
 * "este pedido no puede seguir cobrándose solo": si un día cambia el criterio, cambia en un lugar.
 *
 * Reglas:
 *  · Sin proyección de deriva cableada no se evalúa nada — un tenant que jamás enchufó esto
 *    (credipower) no cambia en un ápice, igual que en el resto del módulo.
 *  · Una orden sin ítems legibles se trata como `unverifiable`: no podemos decir QUÉ estamos por
 *    cobrar, y mandar el total de algo que no sabemos atribuir es justo lo que este guard impide.
 *  · FAIL-CLOSED en la lectura: acá hay dinero comprometido, así que "no pude leer la proyección"
 *    no vale como "no hay deriva".
 */
export async function assertOrdenSinDerivaCritica(
  tenantId: string,
  orderId: string,
  items: readonly { productId?: string; productName?: string }[] | undefined,
  ctx: Record<string, unknown> = {},
): Promise<void> {
  if (!driftGuardCableado()) return;
  const consultados = (items ?? [])
    .filter((i): i is { productId: string; productName?: string } => typeof i?.productId === 'string' && i.productId !== '')
    .map((i) => ({ id: i.productId, name: i.productName || i.productId }));
  const deriva: VeredictoDeriva = consultados.length
    ? await leerDeriva(tenantId, consultados, { failClosed: true })
    : { bloqueantes: [{ productId: orderId, productName: 'pedido sin ítems', reason: 'unverifiable', fields: [...CAMPOS_CRITICOS] }], advertencias: [] };
  if (!deriva.bloqueantes.length) return;
  logger.warn('Checkout frenado: deriva crítica sobre una orden ya creada', { tenantId, orderId, ...ctx, ...resumenSaneado(deriva) });
  throw new ProductoConDerivaCriticaError(deriva);
}

// Dirección vacía: la recolección de domicilio es de la fase de logística (futuro).
function emptyAddress(): Address {
  return {
    street: '',
    houseNumber: '',
    city: '',
    neighborhood: '',
    reference: '',
    coordinates: null,
  };
}

/** COVERAGE-1D: opciones para la reanudación idempotente del checkout. */
export interface CreatePendingOrderOpts {
  /** orderId RESERVADO previamente (idempotencia del worker de reanudación). */
  orderId?: string;
  /** Referencia auditable a la cobertura aprobada (jamás coordenadas). */
  coverage?: { requestId: string; locationFingerprint: string | null };
  /** Dirección TEXTUAL del cliente (la exacta con coordenadas vive solo en coverageRequests). */
  deliveryAddress?: Address;
  /**
   * KILL-SWITCH-1 (cobertura): precondición evaluada DENTRO de la transacción que crea la orden
   * (lecturas antes de escrituras — misma creación idempotente, ahora atómica con el guard).
   * false ⇒ NO se crea nada (ni orden ni finanzas) y se devuelve null.
   */
  guard?: (tx: Transaction) => Promise<boolean>;
  /**
   * SHIPPING-CHAT-3C: cargo de envío ESTRUCTURADO (entero Gs; default 0). Se persiste separado en
   * `totals.shipping` vía computeOrderTotals — jamás se suma al subtotal ni a la ganancia.
   */
  shippingGs?: number;
}

export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: OrderCartInput,
  opts?: CreatePendingOrderOpts & { guard?: undefined },
): Promise<Order>;
export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: OrderCartInput,
  opts: CreatePendingOrderOpts & { guard: NonNullable<CreatePendingOrderOpts['guard']> },
): Promise<Order | null>;
export async function createPendingOrder(
  tenantId: string,
  customerId: string,
  cart: OrderCartInput,
  opts: CreatePendingOrderOpts = {},
): Promise<Order | null> {
  const now = Timestamp.now();
  const orderId = opts.orderId ?? newOrderId();

  // COVERAGE-1D (review): con un orderId RESERVADO, un worker stale jamás pisa la orden que
  // otro worker ya creó (ni sus finanzas congeladas) — si existe, se reusa tal cual.
  if (opts.orderId) {
    const existente = await db().doc(paths.order(tenantId, orderId)).get();
    if (existente.exists) {
      const orden = existente.data() as Order;
      // POR QUÉ SE CONSERVA EL EARLY-RETURN y qué agrega el chequeo de acá abajo:
      //  · se conserva porque es la garantía COVERAGE-1D: la orden que otro worker ya creó —y sus
      //    finanzas congeladas— no se reescribe JAMÁS. Este camino sigue devolviéndola intacta,
      //    sin tocar un solo campo ni volver a calcular totales.
      //  · se agrega el chequeo porque devolverla intacta hace que el llamador CONTINÚE el flujo
      //    comercial (manda el total y los datos bancarios) sobre un producto que puede estar en
      //    deriva crítica, salteándose las dos revalidaciones de más abajo. La ventana es angosta
      //    —el único llamador con `orderId` (la reanudación de cobertura) ya evalúa la deriva
      //    antes— pero se cierra igual: es exactamente el patrón que dejó pasar el bug original,
      //    otro worker creando la orden entre una lectura y la otra.
      // Se evalúa lo que pide LA ORDEN EXISTENTE (es lo que se va a cobrar), no el carrito que
      // llegó por parámetro, que pudo cambiar después de que esa orden naciera.
      await assertOrdenSinDerivaCritica(tenantId, orderId, orden.items, { customerId, motivo: 'orden_reservada_ya_existente' });
      return orden;
    }
  }

  // REVALIDACIÓN DE VENDIBILIDAD (META-CATALOG-RECONCILIATION-1): el carrito puede haberse
  // armado antes de que un producto se desactivara o quedara sin stock. Un pedido jamás debe
  // nacer con algo que ya no se puede vender (y un producto importado de Meta, INACTIVE por
  // definición, nunca puede llegar acá).
  const noVendibles: string[] = [];
  await Promise.all(
    cart.items.map(async (i) => {
      const snap = await db().doc(paths.product(tenantId, i.productId)).get();
      const p = snap.data() as { status?: string; inventory?: { trackStock?: boolean; stock?: number }; name?: string } | undefined;
      const vendible = !!p && p.status === 'ACTIVE' && (!p.inventory?.trackStock || (p.inventory?.stock ?? 0) > 0);
      if (!vendible) noVendibles.push(i.name || i.productId);
    }),
  );
  if (noVendibles.length) {
    logger.warn('Checkout bloqueado: producto no vendible en el carrito', { tenantId, customerId, cantidad: noVendibles.length });
    throw new ProductNoVendibleError(noVendibles);
  }

  // REVALIDACIÓN DE HONESTIDAD DEL DATO PÚBLICO (ADR-0015 §8). Va acá y no solo en el motor
  // porque este es el ÚNICO punto por el que nace un pedido: cubre el checkout del bot y la
  // reanudación tras la aprobación de cobertura (donde el carrito se congeló mucho antes). Es una
  // proyección local, sin llamadas a Meta: el camino crítico jamás depende de una lectura externa,
  // y el precio que se cobra sigue siendo el LOCAL — lo que cambia es que no se cobra a ciegas.
  // `failClosed`: acá "no hay deriva" y "no pude leer si la hay" NO son lo mismo. Este es el punto
  // donde nace el compromiso comercial, así que un error de la proyección frena el pedido en vez de
  // dejarlo pasar (el camino conversacional sí sigue fail-open: una respuesta de más no cobra nada).
  const deriva = await leerDeriva(tenantId, cart.items.map((i) => ({ id: i.productId, name: i.name })), { failClosed: true });
  if (deriva.bloqueantes.length) {
    logger.warn('Checkout bloqueado: deriva crítica del dato público', { tenantId, customerId, ...resumenSaneado(deriva) });
    throw new ProductoConDerivaCriticaError(deriva);
  }

  // El costo (privado) se lee de productFinancials y se "congela" en orderFinancials.
  // La orden visible NO lleva costo/ganancia (legible por el vendedor). Ver ADR-0008.
  const rows = await Promise.all(
    cart.items.map(async (i) => {
      const unitCost = await getProductCost(tenantId, i.productId);
      const subtotal = i.price * i.quantity;
      const item: OrderItem = {
        itemId: newOrderItemId(),
        productId: i.productId,
        productName: i.name,
        unitPrice: i.price,
        quantity: i.quantity,
        subtotal,
      };
      const fin: OrderFinancialsItem = {
        productId: i.productId,
        quantity: i.quantity,
        unitCostSnapshot: unitCost,
        totalCostSnapshot: unitCost == null ? null : unitCost * i.quantity,
      };
      return { item, fin };
    }),
  );
  const items = rows.map((r) => r.item);
  const finItems = rows.map((r) => r.fin);

  // Totales financieros (privados): si algún ítem no tiene costo, la ganancia queda incompleta.
  const costoIncompleto = finItems.some((fi) => fi.totalCostSnapshot == null);
  const totalCost = costoIncompleto ? null : finItems.reduce((s, fi) => s + (fi.totalCostSnapshot ?? 0), 0);
  const grossProfit = totalCost == null ? null : cart.subtotal - totalCost;
  const grossMarginPercentage =
    grossProfit == null || cart.subtotal <= 0 ? null : (grossProfit / cart.subtotal) * 100;

  // Atribución (D5): el pedido hereda de qué campaña vino el cliente.
  const custData = (await db().doc(paths.customer(tenantId, customerId)).get()).data() as { attribution?: Order['attribution'] } | undefined;
  const attribution = custData?.attribution;

  // SHIPPING-CHAT-3C: totales por la ÚNICA fuente compartida (total = subtotal - discount +
  // shipping). Todos los pedidos nuevos persisten `totals.shipping` (0 sin cotización). El
  // subtotal y grossProfit siguen siendo SOLO de productos: el envío jamás infla la ganancia.
  // computeOrderTotals valida enteros seguros: en el camino CON cotización un carrito corrupto
  // FALLA acá (jamás una orden con dinero cotizado inválido). SIN cotización (flag apagado /
  // checkout legado) se preserva el comportamiento previo: el checkout nunca validó el subtotal
  // como entero y un precio irregular del catálogo no debe romper la venta — total legado
  // (subtotal tal cual, shipping 0) con rastro para corregir el dato.
  let totals: Order['totals'];
  try {
    totals = computeOrderTotals({ subtotalGs: cart.subtotal, discountGs: 0, shippingGs: opts.shippingGs ?? 0 });
  } catch (e) {
    if (typeof opts.shippingGs === 'number') throw e;
    logger.warn('Pedido con subtotal no entero: totales en modo compat legado (shipping 0)', { tenantId, customerId });
    totals = { subtotal: cart.subtotal, discount: 0, shipping: 0, total: cart.subtotal, currency: 'PYG' };
  }

  const order: Order = {
    id: orderId,
    tenantId,
    customerId,
    status: 'PENDING_PAYMENT',
    items,
    totals,
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null }, // provisional; se confirma al pagar
    delivery: { deliveryId: null, address: opts.deliveryAddress ?? emptyAddress() },
    invoice: { invoiceId: null, number: null },
    channel: 'WHATSAPP',
    sellerId: null, // se asigna en el handoff
    source: 'whatsapp-bot', // tracking (prep Track C)
    ...(attribution ? { attribution } : {}),
    ...(opts.coverage ? { coverage: opts.coverage } : {}),
    notes: '',
    createdAt: now,
    updatedAt: now,
  };

  const orderFinancials: OrderFinancials = {
    orderId,
    tenantId,
    subtotal: cart.subtotal,
    totalCost,
    grossProfit,
    grossMarginPercentage,
    items: finItems,
    createdAt: now,
    updatedAt: now,
  };

  // KILL-SWITCH-1: con guard, la precondición y la creación idempotente van en UNA transacción
  // (lecturas primero): si el guard da false, no se escribe NADA — ni orden ni finanzas.
  if (opts.guard) {
    const creado = await db().runTransaction(async (tx) => {
      const oSnap = await tx.get(db().doc(paths.order(tenantId, orderId)));
      if (oSnap.exists) return oSnap.data() as Order; // reserva 1D: la orden existente se reusa intacta
      if (!(await opts.guard!(tx))) return null;
      tx.set(db().doc(paths.orderFinancial(tenantId, orderId)), orderFinancials);
      tx.create(db().doc(paths.order(tenantId, orderId)), order);
      return order;
    });
    if (creado) logger.info('Pre-orden creada', { tenantId, customerId, orderId });
    return creado;
  }

  // Finanzas privadas PRIMERO: así el trigger de stats (que escucha la orden) ya las encuentra.
  // Un orphan de orderFinancials (si fallara el 2º write) es inofensivo: no hay orden visible.
  await db().doc(paths.orderFinancial(tenantId, orderId)).set(orderFinancials);
  if (opts.orderId) {
    // Reserva 1D: `create()` — si otro worker ganó la carrera, se devuelve SU orden intacta.
    try {
      await db().doc(paths.order(tenantId, orderId)).create(order);
    } catch (e) {
      const code = (e as { code?: number | string }).code;
      if (code === 6 || code === 'already-exists') {
        return (await db().doc(paths.order(tenantId, orderId)).get()).data() as Order;
      }
      throw e;
    }
  } else {
    await db().doc(paths.order(tenantId, orderId)).set(order);
  }

  logger.info('Pre-orden creada', { tenantId, customerId, orderId });
  return order;
}
