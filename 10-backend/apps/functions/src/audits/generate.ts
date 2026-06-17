/**
 * audits/generate.ts — Auditoría del agente por REGLAS (P16)
 * ==========================================================
 * Revisa el historial de conversaciones + el catálogo y marca hallazgos en
 * tenants/{t}/agentAudits. Sin IA. Reglas:
 *   - NOT_UNDERSTOOD: el bot cayó ≥2 veces al mensaje de "no entendí".
 *   - POSSIBLE_COMPLAINT_NO_HANDOFF: posible reclamo sin pasar a un vendedor.
 *   - PRODUCT_INCOMPLETE: producto activo sin notas IA / descripción / costo.
 * Idempotente: ids deterministas, no revive lo resuelto, limpia lo que ya no aplica.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Customer, Product, ProductFinancials, Message, AgentAudit } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

const DAY = 86_400_000;
const FALLBACK_MARK = 'encontrar tu perfume ideal'; // frase del mensaje de "no entendí"
const COMPLAINT = /(reclam|queja|devoluc|estafa|denunci|no funciona|no anda|roto|defectuos|p[eé]simo|horrible|fraude|me robaron)/i;
const cname = (c?: Customer) => c?.name?.trim() || c?.whatsappPhone || c?.id || 'el cliente';
const ms = (ts: unknown): number => (ts as { toDate?: () => Date } | null)?.toDate?.()?.getTime() ?? 0;

type NewAudit = Omit<AgentAudit, 'id' | 'tenantId' | 'createdAt' | 'resolvedAt' | 'status'>;

async function syncAudits(tenantId: string, items: Array<{ id: string; audit: NewAudit }>): Promise<number> {
  const existing = await db().collection(paths.agentAudits(tenantId)).get();
  const acted = new Set<string>();
  const open = new Set<string>();
  existing.docs.forEach((d) => {
    const s = (d.data() as AgentAudit).status;
    if (s !== 'OPEN') acted.add(d.id);
    else open.add(d.id);
  });
  const now = Timestamp.now();
  const batch = db().batch();
  const gen = new Set<string>();
  for (const { id, audit } of items) {
    gen.add(id);
    if (acted.has(id)) continue;
    const full: AgentAudit = { id, tenantId, ...audit, status: 'OPEN', createdAt: now, resolvedAt: null };
    batch.set(db().doc(paths.agentAudit(tenantId, id)), full);
  }
  for (const id of open) if (!gen.has(id)) batch.delete(db().doc(paths.agentAudit(tenantId, id)));
  await batch.commit();
  return gen.size;
}

export async function generateAgentAudits(tenantId: string): Promise<number> {
  const [custSnap, prodSnap, finSnap] = await Promise.all([
    db().collection(paths.customers(tenantId)).get(),
    db().collection(paths.products(tenantId)).get(),
    db().collection(paths.productFinancials(tenantId)).get(),
  ]);
  const customers = custSnap.docs.map((d) => d.data() as Customer);
  const products = prodSnap.docs.map((d) => d.data() as Product);
  const hasCost = new Set<string>();
  finSnap.docs.forEach((d) => { if (((d.data() as ProductFinancials).costPrice ?? null) != null) hasCost.add(d.id); });

  const nowMs = Date.now();
  const items: Array<{ id: string; audit: NewAudit }> = [];

  // Reglas A y B: por conversación activa (últimos 30 días).
  const active = customers.filter((c) => {
    const t = ms(c.conversation?.lastMessageAt);
    return t && nowMs - t <= 30 * DAY;
  });
  for (const c of active) {
    const msgs = (await db().collection(paths.messages(tenantId, c.id)).orderBy('createdAt', 'asc').limit(100).get()).docs.map((d) => d.data() as Message);
    const fallbacks = msgs.filter((m) => m.direction === 'out' && m.author === 'bot' && m.text.includes(FALLBACK_MARK)).length;
    if (fallbacks >= 2) {
      items.push({ id: `audit-nounderstand-${c.id}`, audit: { issueType: 'NOT_UNDERSTOOD', severity: 'MEDIUM', conversationId: c.id, relatedEntityType: 'conversation', relatedEntityId: c.id, summary: `El bot no entendió ${fallbacks} veces en el chat de ${cname(c)}.`, recommendedFix: 'Agregá esas preguntas a las FAQ o ampliá las reglas de venta.' } });
    }
    const complaint = msgs.some((m) => m.direction === 'in' && m.author === 'customer' && COMPLAINT.test(m.text));
    if (complaint && !c.conversation?.humanTakeover) {
      items.push({ id: `audit-complaint-${c.id}`, audit: { issueType: 'POSSIBLE_COMPLAINT_NO_HANDOFF', severity: 'HIGH', conversationId: c.id, relatedEntityType: 'conversation', relatedEntityId: c.id, summary: `Posible reclamo de ${cname(c)} sin pasar a un vendedor.`, recommendedFix: 'Revisá el chat y hacé que el bot derive a un vendedor ante reclamos.' } });
    }
  }

  // Regla C: catálogo incompleto (productos activos).
  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    const falta: string[] = [];
    if (!p.aiNotes?.trim()) falta.push('notas para la IA');
    if (!p.description?.trim()) falta.push('descripción');
    if (!hasCost.has(p.id)) falta.push('precio de costo');
    if (falta.length) {
      items.push({ id: `audit-product-${p.id}`, audit: { issueType: 'PRODUCT_INCOMPLETE', severity: 'LOW', conversationId: null, relatedEntityType: 'product', relatedEntityId: p.id, summary: `"${p.name}" tiene info incompleta: falta ${falta.join(', ')}.`, recommendedFix: 'Completá esos campos en el catálogo para que el bot venda mejor.' } });
    }
  }

  const n = await syncAudits(tenantId, items);
  logger.info('Auditoría del agente generada', { tenantId, hallazgos: n });
  return n;
}
