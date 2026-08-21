/**
 * orders/checkoutUnconfigured.ts — «este tenant no puede cobrar» dicho en voz alta
 * ================================================================================
 * H-04: cuando un cliente llega a pagar y el tenant no tiene ninguna cuenta cobrable, el bot
 * NO instruye un pago (antes mandaba los placeholders del seed). Que el bot se calle es solo
 * la mitad del arreglo: **el dueño tiene que enterarse**, porque una venta cerrada que no se
 * puede cobrar es exactamente la clase de falla silenciosa que más caro salió en este proyecto.
 *
 * Idempotencia: id determinístico con bucket POR DÍA, el mismo criterio anti-flood que ya usa
 * `conversation/aiUnavailable.ts` cuando no hay vendedor. Sin el bucket, cada cliente que
 * intente pagar dispararía un aviso; con un id fijo para siempre, el problema quedaría mudo si
 * el dueño lo resuelve y más tarde vuelve a romperse. Un aviso por día mientras dure.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

/** Bucket diario del aviso (UTC, igual que el anti-flood de `aiUnavailable`). */
export function idAvisoSinDatosDeCobro(tenantId: string, ahoraMs: number): string {
  return `checkout-sin-datos-${tenantId}-${new Date(ahoraMs).toISOString().slice(0, 10)}`;
}

/**
 * Avisa al owner/manager que hay clientes intentando pagar sin datos de cobro cargados.
 * Best-effort SIEMPRE: un fallo acá jamás rompe la conversación ni el pedido.
 * Devuelve `true` si creó el aviso (la primera vez del día), `false` si ya estaba o falló.
 */
export async function avisarCheckoutSinDatos(
  tenantId: string,
  /** Cliente que se quedó esperando: el aviso abre SU conversación desde la campana. */
  customerId?: string | null,
  ahoraMs = Date.now(),
): Promise<boolean> {
  const id = idAvisoSinDatosDeCobro(tenantId, ahoraMs);
  try {
    await db().doc(`${paths.notifications(tenantId)}/${id}`).create({
      id,
      tenantId,
      category: 'handoff',
      type: 'handoff_checkout_unconfigured',
      title: '💳 Un cliente quiso pagar y no hay datos de cobro',
      // El cuerpo dice QUÉ falta y no lleva PII: ni el teléfono del cliente ni el contenido de su
      // mensaje. El `customerId` viaja aparte (abajo), como en el resto de los avisos de handoff,
      // para que la campana pueda abrir esa conversación.
      body:
        'Tu bot no puede pasar datos de transferencia porque no tenés ninguna cuenta bancaria cargada. ' +
        'Cargala en Config. del agente → Datos de cobro. Mientras tanto el pedido queda anotado y el ' +
        'cliente sabe que todavía no podés recibir transferencias: la venta la tenés que cerrar vos.',
      dedupeKey: id,
      // Mismo criterio que el resto de los avisos de handoff: la campana abre la conversación de
      // quien quedó esperando (el primero del día — el aviso es agregado, no uno por cliente).
      ...(customerId ? { customerId } : {}),
      read: false,
      readAt: null,
      severity: 'high',
      createdAt: Timestamp.now(),
    });
    logger.warn('Checkout sin datos de cobro: el tenant no puede cobrar por el bot', { tenantId });
    return true;
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return false; // ya avisado hoy
    logger.warn('No se pudo crear el aviso de checkout sin datos de cobro', { tenantId });
    return false;
  }
}

/**
 * Lo que el cliente recibe cuando el tenant no puede cobrar. No inventa una cuenta y **no promete
 * que alguien lo va a contactar**: no hay handoff detrás que lo respalde, y el propio sistema se
 * prohíbe esa promesa (`ai/prompts.ts`). Dice la verdad y deja el pedido en pie.
 */
export const MENSAJE_SIN_DATOS_DE_COBRO =
  'Ya tengo tu pedido anotado 🧾 Todavía no puedo pasarte los datos para transferir — están ' +
  'terminando de configurarse. Escribime por acá y el equipo lo va a ver en cuanto se conecte 🙌';
