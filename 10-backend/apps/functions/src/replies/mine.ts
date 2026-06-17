/**
 * replies/mine.ts — Minero de respuestas ganadoras (P18)
 * ======================================================
 * Recorre los chats que cerraron venta (cliente con pedido PAID) y cuenta qué
 * respuestas SALIENTES (bot/vendedor) aparecieron en ellos. Las que se repiten
 * en ≥2 chats convertidos se guardan como respuestas "auto" con su nº de
 * conversiones, en tenants/{t}/winningReplies. Sin IA. Idempotente.
 * (Cuando se conecte WhatsApp, también entrarán los mensajes del vendedor.)
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Order, Message, WinningReply } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const PAID = ['PAID', 'PREPARING', 'ASSIGNED', 'IN_TRANSIT', 'DELIVERED'];
const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const slug = (t: string) =>
  norm(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export async function generateWinningReplies(tenantId: string): Promise<number> {
  const ordSnap = await db().collection(paths.orders(tenantId)).get();
  const converting = new Set<string>();
  ordSnap.docs.map((d) => d.data() as Order).filter((o) => PAID.includes(o.status)).forEach((o) => converting.add(o.customerId));

  // Contar conversiones por texto de respuesta (una vez por chat).
  const counts = new Map<string, { text: string; conversions: number }>();
  for (const cid of converting) {
    const msgs = (await db().collection(paths.messages(tenantId, cid)).limit(200).get()).docs.map((d) => d.data() as Message);
    const seen = new Set<string>();
    for (const m of msgs) {
      if (m.direction !== 'out' || m.author === 'system') continue;
      const n = norm(m.text);
      if (n.length < 20 || n.length > 400 || seen.has(n)) continue;
      seen.add(n);
      const e = counts.get(n) ?? { text: m.text, conversions: 0 };
      e.conversions += 1;
      counts.set(n, e);
    }
  }

  const existing = await db().collection(paths.winningReplies(tenantId)).get();
  const autoActive = new Set<string>();
  existing.docs.forEach((d) => {
    const r = d.data() as WinningReply;
    if (r.source === 'auto' && r.status === 'ACTIVE') autoActive.add(d.id);
  });

  const now = Timestamp.now();
  const batch = db().batch();
  const gen = new Set<string>();
  for (const [, e] of counts) {
    if (e.conversions < 2) continue;
    const id = `auto-${slug(e.text)}`;
    gen.add(id);
    const reply: WinningReply = { id, tenantId, text: e.text, category: 'Auto', source: 'auto', conversions: e.conversions, status: 'ACTIVE', createdAt: now, updatedAt: now };
    batch.set(db().doc(paths.winningReply(tenantId, id)), reply, { merge: true });
  }
  for (const id of autoActive) if (!gen.has(id)) batch.delete(db().doc(paths.winningReply(tenantId, id)));
  await batch.commit();
  logger.info('Respuestas ganadoras (auto) actualizadas', { tenantId, total: gen.size });
  return gen.size;
}
