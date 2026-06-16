/**
 * conversation/cart.ts — Lógica del carrito (F5.2)
 * ================================================
 * Funciones puras sobre el Cart de la sesión. Sin acceso a DB ni a red:
 * reciben el carrito actual + un producto y devuelven el carrito nuevo.
 * El motor (engine.ts) las usa y persiste el resultado en la sesión.
 */

import type { Cart, Product } from '@vpw/shared';

const GS = (n: number) => '₲ ' + n.toLocaleString('es-PY');

function recalcular(items: Cart['items']): Cart {
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items, subtotal };
}

/** Agrega un producto al carrito (o incrementa la cantidad si ya estaba). */
export function addToCart(cart: Cart, product: Product, qty = 1): Cart {
  const items = cart.items.map((i) => ({ ...i }));
  const idx = items.findIndex((i) => i.productId === product.id);
  if (idx >= 0) {
    items[idx]!.quantity += qty;
  } else {
    items.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity: qty,
      imageUrl: product.images?.[0] ?? '',
    });
  }
  return recalcular(items);
}

/** Texto del carrito para mostrar al cliente. */
export function formatCart(cart: Cart): string {
  if (cart.items.length === 0) {
    return '🛒 Tu carrito está vacío. Escribí *catálogo* para ver perfumes.';
  }
  let out = '🛒 *Tu carrito:*\n';
  for (const i of cart.items) {
    out += `\n• ${i.name} x${i.quantity} — ${GS(i.price * i.quantity)}`;
  }
  out += `\n\n*Total: ${GS(cart.subtotal)}*\nEscribí *pagar* cuando quieras finalizar 💳`;
  return out;
}
