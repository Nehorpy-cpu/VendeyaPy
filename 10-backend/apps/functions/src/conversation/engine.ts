/**
 * conversation/engine.ts — Motor de conversación del bot (F4)
 * ===========================================================
 * Recibe un mensaje, maneja la SESIÓN del cliente en Firestore y devuelve
 * una respuesta. Es channel-agnostic: NO sabe si la respuesta sale por WhatsApp
 * real o por el endpoint de prueba (ADR-0003). El cómo se entrega es del que llama.
 *
 * Fase 5: catálogo real + carrito. El cerebro de IA (Claude/GPT) se enchufa
 * más adelante, reemplazando la lógica por reglas de decidirRespuesta().
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Session, SessionState, Product, Cart } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import {
  searchCatalog,
  getProductById,
  findProductByName,
  type CatalogFilters,
} from '../catalog/search.js';
import { addToCart, formatCart } from './cart.js';
import { createPendingOrder } from '../orders/createPendingOrder.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 horas

export interface ConversationInput {
  tenantId: string;
  from: string; // teléfono del cliente
  text: string;
}

export interface ConversationResult {
  reply: string;
  state: SessionState;
}

/** El teléfono (solo dígitos) sirve de id de cliente. */
function customerIdFromPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

function esSaludo(text: string): boolean {
  return /\b(hola|buenas|buen[oa]s?\s+(d[ií]as|tardes|noches)|hi|hello|menu|men[uú]|inicio)\b/i.test(
    text.trim(),
  );
}

const GS = (n: number) => '₲ ' + n.toLocaleString('es-PY');

function detectarEstilo(t: string): string | undefined {
  const mapa: Record<string, string[]> = {
    dulce: ['dulce', 'azucar', 'vainilla', 'gourmand'],
    floral: ['floral', 'flor', 'rosas', 'jazmin', 'jazmín'],
    fresco: ['fresco', 'fresc', 'ligero', 'verano', 'limpio'],
    intenso: ['intenso', 'fuerte', 'noche', 'seductor', 'potente'],
    'árabe': ['arabe', 'árabe', 'oud', 'lattafa'],
    'cítrico': ['citric', 'cítric', 'limon', 'limón'],
    frutal: ['frutal', 'fruta'],
    amaderado: ['amaderad', 'madera'],
  };
  for (const [estilo, kws] of Object.entries(mapa)) {
    if (kws.some((k) => t.includes(k))) return estilo;
  }
  return undefined;
}

function detectarGenero(t: string): string {
  if (/\b(para (e|é)l|hombre|masculino|caballero|novio|esposo)\b/.test(t)) return 'Masculino';
  return 'Femenino'; // default: foco perfumería femenina
}

function detectarPrecio(t: string): { maxPrice?: number; priceRange?: string } {
  const mMil = t.match(/(\d+)\s*mil/);
  if (mMil) return { maxPrice: parseInt(mMil[1]!, 10) * 1000 };
  const mNum = t.match(/(\d{5,7})/);
  if (mNum) return { maxPrice: parseInt(mNum[1]!, 10) };
  if (/(econom|barat|accesible|poco)/.test(t)) return { priceRange: 'ACCESIBLE' };
  if (/(premium|caro|lujo|exclusiv)/.test(t)) return { priceRange: 'PREMIUM' };
  return {};
}

function quiereCatalogo(t: string): boolean {
  return (
    /\b(cat[aá]logo|ver|mostrar|muestra|perfume|fragancia|recomend|busco|quiero|tienen|ten[eé]s|regalo|opciones|barat|econom|accesible|premium|lujo)\b/.test(
      t,
    ) ||
    detectarEstilo(t) !== undefined ||
    Object.keys(detectarPrecio(t)).length > 0
  );
}

function emojiDe(p: Product): string {
  const s = p.perfume?.styleTags ?? [];
  if (s.includes('árabe') || s.includes('intenso')) return '🔥';
  if (s.includes('dulce') || s.includes('gourmand')) return '🍬';
  if (s.includes('fresco') || s.includes('cítrico')) return '🌊';
  return '🌸';
}

function formatearProductos(productos: Product[]): string {
  let out = '✨ Mirá, te elegí estas opciones:\n';
  for (const p of productos) {
    out += `\n${emojiDe(p)} *${p.name} – ${p.perfume?.brand}* → ${GS(p.price)}`;
    if (p.inventory && p.inventory.stock <= 3) out += `  ⚠️ ¡Últimas ${p.inventory.stock}!`;
    if (p.featured) out += '\n   Uno de nuestros más vendidos 🌟';
  }
  out += '\n\n¿Cuál te gusta más? Decime el *número* o el *nombre* para agregarlo 🛒';
  return out;
}

function quiereVerCarrito(t: string): boolean {
  return /\b(carrito|mi pedido|qu[eé] llevo|qu[eé] tengo|mi compra)\b/.test(t);
}

function quiereAgregar(t: string): boolean {
  return /\b(agreg|añad|anad|sum[aá]|llev|me lo llevo|me la llevo|lo quiero|la quiero|lo llevo|la llevo)\b/.test(
    t,
  );
}

function quierePagar(t: string): boolean {
  return /\b(pagar|pago|finalizar|comprar|checkout|cobrar|terminar (compra|pedido))\b/.test(t);
}

/** Mapea "el primero/segundo/tercero" o "1/2/3" a un índice 0-based. */
function ordinalIndex(t: string): number | null {
  if (/\b(primero|primera|primer|1)\b/.test(t)) return 0;
  if (/\b(segundo|segunda|2)\b/.test(t)) return 1;
  if (/\b(tercero|tercera|3)\b/.test(t)) return 2;
  return null;
}

/**
 * Resuelve qué producto quiere el cliente:
 *  - por orden ("el primero") sobre lo último mostrado, o
 *  - por nombre ("agregá Good Girl") — solo si hay intención de agregar (evita reads de más).
 */
async function resolverSeleccion(
  tenantId: string,
  t: string,
  lastShownSkus: string[],
): Promise<Product | null> {
  const idx = ordinalIndex(t);
  if (idx !== null && lastShownSkus[idx]) {
    const p = await getProductById(tenantId, lastShownSkus[idx]!);
    if (p) return p;
  }
  if (quiereAgregar(t)) {
    return findProductByName(tenantId, t);
  }
  return null;
}

/**
 * Decide la respuesta. PUNTO DE EXTENSIÓN: acá se enchufa el cerebro de IA
 * (Claude/GPT) en una fase futura, reemplazando estas reglas.
 */
async function decidirRespuesta(
  tenantId: string,
  customerId: string,
  text: string,
  esNuevo: boolean,
  prev: { cart: Cart; lastShownSkus: string[] },
): Promise<{
  reply: string;
  nextState: SessionState;
  cart?: Cart;
  lastShownSkus?: string[];
  pendingOrderId?: string;
}> {
  const t = text.toLowerCase();

  // 1. Saludo / cliente nuevo
  if (esNuevo || esSaludo(text)) {
    return {
      reply:
        '¡Hola! 💖 Bienvenida a *Perfumería AFG*. Soy Sofía, tu asesora.\n' +
        '¿Buscás algo para vos o para regalar? Contame qué estilo te gusta ' +
        '(dulce, floral, fresco, intenso...) y te muestro opciones ✨',
      nextState: 'BROWSING',
    };
  }

  // 2. Ver carrito
  if (quiereVerCarrito(t)) {
    return { reply: formatCart(prev.cart), nextState: 'CART' };
  }

  // 3. Pagar → crear pre-orden + link de pago
  if (quierePagar(t)) {
    if (prev.cart.items.length === 0) {
      return {
        reply: '🛒 Tu carrito está vacío. Agregá algún perfume primero (escribí *catálogo*).',
        nextState: 'BROWSING',
      };
    }
    const { order, paymentLink } = await createPendingOrder(tenantId, customerId, prev.cart);
    return {
      reply:
        `💳 *Resumen de tu compra*\nTotal a pagar: *${GS(order.totals.total)}*\n\n` +
        `🔗 Link de pago:\n${paymentLink}\n\n` +
        'Apenas confirmemos el pago te aviso 🙌 (este link es de prueba por ahora).',
      nextState: 'AWAITING_PAYMENT',
      pendingOrderId: order.id,
    };
  }

  // 4. Agregar al carrito (seleccionar producto por orden o nombre)
  const seleccion = await resolverSeleccion(tenantId, t, prev.lastShownSkus);
  if (seleccion) {
    const cart = addToCart(prev.cart, seleccion);
    const unidades = cart.items.reduce((n, i) => n + i.quantity, 0);
    return {
      reply:
        `✅ Agregué *${seleccion.name}* a tu carrito.\n` +
        `🛒 Llevás ${unidades} producto(s) — Total: ${GS(cart.subtotal)}\n\n` +
        'Seguí mirando (*catálogo*) o escribí *carrito* / *pagar*.',
      nextState: 'CART',
      cart,
    };
  }
  if (quiereAgregar(t)) {
    return {
      reply: 'Decime cuál querés agregar 🙂 — el *número* (1, 2, 3) o el *nombre* del perfume.',
      nextState: 'VIEWING_PRODUCT',
    };
  }

  // 5. Catálogo / búsqueda
  if (quiereCatalogo(t)) {
    const filtros: CatalogFilters = {
      gender: detectarGenero(t),
      styleTag: detectarEstilo(t),
      ...detectarPrecio(t),
      limit: 3,
    };
    const productos = await searchCatalog(tenantId, filtros);
    if (productos.length === 0) {
      return {
        reply:
          'Mmm, no encontré algo que encaje justo con eso 🤔. ¿Querés que te muestre ' +
          'nuestros más vendidos, o ajustamos el presupuesto?',
        nextState: 'BROWSING',
      };
    }
    return {
      reply: formatearProductos(productos),
      nextState: 'VIEWING_PRODUCT',
      lastShownSkus: productos.map((p) => p.id),
    };
  }

  // 6. Fallback
  return {
    reply:
      'Puedo ayudarte a encontrar tu perfume ideal 🌸. Decime qué estilo buscás ' +
      '(dulce, floral, fresco, intenso) o escribí *catálogo* para ver opciones.',
    nextState: 'BROWSING',
  };
}

export async function handleMessage(input: ConversationInput): Promise<ConversationResult> {
  const { tenantId, from, text } = input;
  const customerId = customerIdFromPhone(from);
  if (!customerId) {
    throw new Error('Teléfono inválido (sin dígitos)');
  }

  const now = Timestamp.now();
  const sessionRef = db().doc(paths.session(tenantId, customerId));
  const snap = await sessionRef.get();
  const existing = snap.exists ? (snap.data() as Session) : null;
  const esNuevo = !existing || existing.state === 'GREETING';
  const prevCart: Cart = existing?.cart ?? { items: [], subtotal: 0 };
  const prevShown: string[] = existing?.context?.lastShownSkus ?? [];

  const result = await decidirRespuesta(tenantId, customerId, text, esNuevo, {
    cart: prevCart,
    lastShownSkus: prevShown,
  });
  const { reply, nextState } = result;

  const session: Session = {
    id: 'active',
    tenantId,
    customerId,
    state: nextState,
    cart: result.cart ?? prevCart,
    context: {
      lastMessageAt: now,
      currentPage: existing?.context?.currentPage ?? 0,
      currentCategoryId: existing?.context?.currentCategoryId ?? null,
      pendingOrderId: result.pendingOrderId ?? existing?.context?.pendingOrderId ?? null,
      pendingPaymentId: existing?.context?.pendingPaymentId ?? null,
      lastShownSkus: result.lastShownSkus ?? prevShown,
    },
    expiresAt: Timestamp.fromMillis(now.toMillis() + SESSION_TTL_MS),
    updatedAt: now,
  };

  // Asegurar que el cliente existe (mínimo) + guardar sesión
  await db()
    .doc(paths.customer(tenantId, customerId))
    .set({ id: customerId, tenantId, whatsappPhone: from, updatedAt: now }, { merge: true });
  await sessionRef.set(session);

  logger.info('Mensaje procesado', { tenantId, customerId, state: nextState });
  return { reply, state: nextState };
}
