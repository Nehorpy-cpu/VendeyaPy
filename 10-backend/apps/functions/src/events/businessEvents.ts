/**
 * events/businessEvents.ts — Capa de eventos + Conversions API (D6)
 * ================================================================
 * recordBusinessEvent: registra un evento del negocio (Purchase, etc.).
 * backfillBusinessEvents: crea eventos Purchase desde los pedidos PAID (demo).
 * sendConversionEvents: mapea los eventos a metaConversionEvents y los "envía" a
 * Meta (en demo se simula; sin conexión quedan 'skipped'). Ver ADR-0009. Idempotente.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Order, BusinessEvent, MetaConversionEvent, BusinessEventName, EventSource } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { PAID_ORDER_STATUSES } from '../orders/lifecycle.js';

const PAID = PAID_ORDER_STATUSES; // fuente única (ORDER-1): orders/lifecycle.ts
const sourceOf = (channel?: string): EventSource => (channel === 'INSTAGRAM' ? 'instagram' : channel === 'FACEBOOK' ? 'messenger' : 'whatsapp');

interface RecordInput {
  id?: string;
  eventName: BusinessEventName;
  eventSource: EventSource;
  customerId?: string | null;
  conversationId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  value?: number | null;
  currency?: string | null;
  campaignId?: string | null;
  occurredAt?: Timestamp;
}

export async function recordBusinessEvent(tenantId: string, e: RecordInput): Promise<void> {
  const now = Timestamp.now();
  const ref = e.id ? db().doc(paths.businessEvent(tenantId, e.id)) : db().collection(paths.businessEvents(tenantId)).doc();
  const ev: BusinessEvent = {
    id: ref.id, tenantId, eventName: e.eventName, eventSource: e.eventSource,
    customerId: e.customerId ?? null, conversationId: e.conversationId ?? null, orderId: e.orderId ?? null, productId: e.productId ?? null,
    value: e.value ?? null, currency: e.currency ?? null, campaignId: e.campaignId ?? null, occurredAt: e.occurredAt ?? now, createdAt: now,
  };
  await ref.set(ev, { merge: true });
}

/** Crea un evento Purchase por cada pedido PAID (idempotente). */
export async function backfillBusinessEvents(tenantId: string): Promise<number> {
  const ordSnap = await db().collection(paths.orders(tenantId)).get();
  const paid = ordSnap.docs.map((d) => d.data() as Order).filter((o) => PAID.includes(o.status));
  for (const o of paid) {
    await recordBusinessEvent(tenantId, {
      id: `purchase-${o.id}`, eventName: 'Purchase', eventSource: sourceOf(o.channel), customerId: o.customerId, conversationId: o.customerId, orderId: o.id,
      value: o.totals.total, currency: o.totals.currency, campaignId: o.attribution?.campaignId ?? null, occurredAt: o.createdAt as Timestamp,
    });
  }
  return paid.length;
}

/** Mapea los eventos a la Conversions API y los "envía" (demo). Sin conexión → skipped. */
export async function sendConversionEvents(tenantId: string): Promise<{ sent: number; skipped: number }> {
  const conn = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data();
  const connected = !!conn?.status && conn.status !== 'not_connected';
  const pixel = (await db().collection(paths.metaAssets(tenantId)).where('assetType', '==', 'pixel').limit(1).get()).docs[0]?.data();
  const pixelId = (pixel?.externalId as string | undefined) ?? null;

  const events = await db().collection(paths.businessEvents(tenantId)).get();
  const already = new Set((await db().collection(paths.metaConversionEvents(tenantId)).get()).docs.map((d) => (d.data() as MetaConversionEvent).businessEventId));
  const now = Timestamp.now();
  const batch = db().batch();
  let sent = 0;
  let skipped = 0;
  for (const d of events.docs) {
    const be = d.data() as BusinessEvent;
    if (already.has(be.id)) continue;
    const status = connected ? 'sent' : 'skipped';
    const ce: MetaConversionEvent = {
      id: `conv-${be.id}`, tenantId, businessEventId: be.id, metaPixelId: pixelId, eventName: be.eventName, sendStatus: status,
      metaResponse: connected ? '{"events_received":1,"fbtrace_id":"demo"}' : '', errorMessage: '', sentAt: connected ? now : null, createdAt: now,
    };
    batch.set(db().doc(paths.metaConversionEvent(tenantId, ce.id)), ce);
    if (connected) sent++; else skipped++;
  }
  await batch.commit();
  logger.info('Conversions API procesada', { tenantId, sent, skipped });
  return { sent, skipped };
}
