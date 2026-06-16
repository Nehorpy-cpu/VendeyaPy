/**
 * conversation/engine.ts — Motor de conversación del bot (F4)
 * ===========================================================
 * Recibe un mensaje, maneja la SESIÓN del cliente en Firestore y devuelve
 * una respuesta. Es channel-agnostic: NO sabe si la respuesta sale por WhatsApp
 * real o por el endpoint de prueba (ADR-0003). El cómo se entrega es del que llama.
 *
 * Fase 4: lógica básica (saludo / acuse). El catálogo llega en F5; el cerebro
 * de IA (Claude/GPT) se enchufa más adelante, reemplazando generarRespuesta().
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Session, SessionState } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

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

/**
 * Genera la respuesta. PUNTO DE EXTENSIÓN: acá se enchufa el cerebro de IA
 * (Claude/GPT) y el catálogo en fases siguientes. Hoy: reglas básicas.
 */
function generarRespuesta(text: string, esNuevo: boolean): { reply: string; nextState: SessionState } {
  if (esNuevo || esSaludo(text)) {
    return {
      reply:
        '¡Hola! 💖 Bienvenida a *Perfumería AFG*. Soy tu asistente.\n' +
        'Por ahora estoy en pruebas — pronto voy a poder mostrarte el catálogo y ' +
        'ayudarte a encontrar tu perfume ideal ✨',
      nextState: 'BROWSING',
    };
  }
  return {
    reply: `Recibí tu mensaje: "${text}" 🙌\nMuy pronto voy a poder responderte con todo el catálogo.`,
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

  const { reply, nextState } = generarRespuesta(text, esNuevo);

  const session: Session = {
    id: 'active',
    tenantId,
    customerId,
    state: nextState,
    cart: existing?.cart ?? { items: [], subtotal: 0 },
    context: {
      lastMessageAt: now,
      currentPage: existing?.context?.currentPage ?? 0,
      currentCategoryId: existing?.context?.currentCategoryId ?? null,
      pendingOrderId: existing?.context?.pendingOrderId ?? null,
      pendingPaymentId: existing?.context?.pendingPaymentId ?? null,
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
