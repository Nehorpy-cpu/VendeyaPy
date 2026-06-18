/**
 * seed-demo.mjs — Demo COMPLETA para recorrer el panel (P1–P14).
 * Limpia y siembra clientes con perfiles variados + pedidos, y dispara los
 * recálculos del copiloto (stats, scores, insights, follow-ups). Solo emulador.
 *
 * USO (emuladores arriba):  node scripts/seed-demo.mjs
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const T = 'perfumeria';
const now = Timestamp.now();
const daysAgo = (d) => Timestamp.fromMillis(Date.now() - d * 86_400_000);

const sellerUid = await getAuth().getUserByEmail('seller@perfumeria.com').then((u) => u.uid).catch(() => null);

// Limpiar colecciones de demo
async function wipe(sub) {
  const snap = await db.collection(`tenants/${T}/${sub}`).get();
  for (const d of snap.docs) {
    for (const s of ['messages', 'sessions', 'items']) {
      const ss = await d.ref.collection(s).get();
      for (const m of ss.docs) await m.ref.delete();
    }
    await d.ref.delete();
  }
}
for (const sub of ['customers', 'orders', 'orderFinancials', 'insights', 'followUpTasks']) await wipe(sub);

const conv = (preview, daysOld, opts = {}) => ({
  lastMessageAt: daysAgo(daysOld), lastMessagePreview: preview, lastMessageDirection: 'in',
  state: 'IDLE', humanTakeover: opts.human ?? false, unreadForSeller: opts.unread ?? 0,
});

// Clientes
const CUSTOMERS = [
  { id: '595981111111', name: 'Carla Giménez', conv: conv('me quedé con el Good Girl 😍', 0) },
  { id: '595982222222', name: 'Rocío Benítez', conv: conv('¿tienen algo floral para regalar?', 0) },
  { id: '595983333333', name: 'Lucía Fernández', conv: conv('¿sigue disponible? quiero pagar 🙏', 0, { human: true, unread: 3 }), assignedSellerId: sellerUid, assignedSellerName: 'Vendedora' },
  { id: '595984444444', name: 'Marta Rojas', conv: conv('gracias por el envío!', 40) },
  { id: '595985555555', name: 'Sofía Vera', conv: conv('ya te paso el comprobante', 0) },
];
for (const c of CUSTOMERS) {
  await db.doc(`tenants/${T}/customers/${c.id}`).set({
    id: c.id, tenantId: T, name: c.name, whatsappPhone: '+' + c.id, tags: [], notes: '',
    conversation: c.conv, assignedSellerId: c.assignedSellerId ?? null, assignedSellerName: c.assignedSellerName ?? null,
    stats: { totalOrders: 0, totalSpent: 0, lastOrderAt: null, firstOrderAt: null },
    createdAt: daysAgo(60), updatedAt: now,
  });
}

// Pedidos (con finanzas privadas)
async function order(id, customerId, status, items, when, campaignId) {
  const total = items.reduce((s, it) => s + it.subtotal, 0);
  await db.doc(`tenants/${T}/orders/${id}`).set({
    id, tenantId: T, customerId, status, items: items.map((it) => ({ itemId: it.productId, productId: it.productId, productName: it.productName, unitPrice: it.subtotal / it.quantity, quantity: it.quantity, subtotal: it.subtotal })),
    totals: { subtotal: total, discount: 0, total, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null },
    channel: 'WHATSAPP', sellerId: null, source: 'whatsapp-bot',
    ...(campaignId ? { attribution: { campaignId, adId: null, type: 'direct_meta', confidence: 1, platform: 'whatsapp' } } : {}),
    notes: '', createdAt: when, updatedAt: when,
  });
  const fin = items.map((it) => ({ productId: it.productId, quantity: it.quantity, unitCostSnapshot: it.cost / it.quantity, totalCostSnapshot: it.cost }));
  const totalCost = fin.reduce((s, f) => s + f.totalCostSnapshot, 0);
  await db.doc(`tenants/${T}/orderFinancials/${id}`).set({ orderId: id, tenantId: T, subtotal: total, totalCost, grossProfit: total - totalCost, grossMarginPercentage: ((total - totalCost) / total) * 100, items: fin, createdAt: when, updatedAt: when });
}
await order('demo-o1', '595981111111', 'PAID', [{ productId: 'good-girl', productName: 'Good Girl', quantity: 1, subtotal: 565000, cost: 300000 }], daysAgo(3), 'camp-1');
await order('demo-o2', '595981111111', 'PAID', [{ productId: 'yara', productName: 'Yara', quantity: 1, subtotal: 180000, cost: 95000 }], daysAgo(1), 'camp-1');
await order('demo-o3', '595984444444', 'PAID', [{ productId: 'yara', productName: 'Yara', quantity: 1, subtotal: 180000, cost: 95000 }], daysAgo(40), 'camp-2');
await order('demo-o4', '595985555555', 'PENDING_PAYMENT', [{ productId: 'la-vie', productName: 'La Vie Est Belle', quantity: 1, subtotal: 650000, cost: 360000 }], now);
await order('demo-o5', '595983333333', 'PENDING_VERIFICATION', [{ productId: 'good-girl', productName: 'Good Girl', quantity: 1, subtotal: 565000, cost: 300000 }], now);

// Recalcular todo el copiloto
const post = (p) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T }) });
await post('devRecomputeStats');
await post('devRecomputeScores');
await post('devGenerateInsights'); // incluye promos + reactivación + sin responder + follow-ups
// Meta (demo): conexión + anuncios + catálogo + atribución
await post('devMetaConnect');
await post('devSyncMetaAds');
await post('devSyncCatalogToMeta');
await post('devComputeAttribution');
await post('devProcessConversions');

console.log('✅ Demo lista: 5 clientes, 5 pedidos (3 ventas atribuidas), copiloto + Meta (anuncios/atribución) recalculados.');
console.log('   Entrá a /dashboard, /decisions, /followups, /customers, /promotions, /ads, /integrations.');
process.exit(0);
