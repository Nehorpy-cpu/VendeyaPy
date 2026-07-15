/**
 * conversation/aiUnavailable.ts — AI-FALLBACK-HONESTO-1
 * ======================================================
 * Cuando una consulta REALMENTE necesitaba IA (bucket conversacional / pregunta de producto)
 * y el gate confirma CUOTA/PRESUPUESTO agotado (`quota_exhausted`), el bot no larga el fallback
 * genérico: deriva HONESTAMENTE a un vendedor con el servicio canónico de HANDOFF-2
 * (`executeHandoff`, razón `ai_unavailable`) y avisa a la campana (idempotente por wamid).
 *
 * Solo cuota agotada deriva: errores transitorios del proveedor, timeouts, config faltante o
 * respuestas vacías NO derivan (siguen al fallback rule-based de siempre) — convertir cada
 * error transitorio en takeover dejaría el bot mudo por un parpadeo del proveedor.
 *
 * El mensaje al cliente jamás menciona tokens/límites/plan/proveedor/errores internos, y se
 * emite SOLO después de que el takeover persistió. Sin vendedor activo no se promete nada.
 */

import { normalizeText } from '../catalog/match.js';
import { getCheckoutConfig } from '../orders/checkoutConfig.js';
import { executeHandoff, notifyHandoffRequested } from './handoff.js';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

export interface DerivarIaNoDisponibleInput {
  /** wamid del inbound (idempotencia del aviso/handoff). */
  messageId?: string | null;
  /**
   * Simulador del panel / test cases: representa el resultado SIN efectos operativos
   * (ni takeover real ni notificación) — la respuesta es la misma que vería el cliente.
   */
  simulation?: boolean;
}
export interface DerivarIaNoDisponibleResult {
  /** true = takeover persistido (o simulado): el caller responde DESPUÉS de esto. */
  takeover: boolean;
  reply: string;
}

export interface DerivarIaNoDisponibleDeps {
  getConfig: typeof getCheckoutConfig;
  handoff: typeof executeHandoff;
  notify: typeof notifyHandoffRequested;
  getAssignedSellerName: (tenantId: string, customerId: string) => Promise<string | null>;
}
const defaultDeps: DerivarIaNoDisponibleDeps = {
  getConfig: getCheckoutConfig,
  handoff: executeHandoff,
  notify: notifyHandoffRequested,
  getAssignedSellerName: async (tenantId, customerId) => {
    const snap = await db().doc(paths.customer(tenantId, customerId)).get();
    return (snap.data()?.assignedSellerName as string | undefined) ?? null;
  },
};

const SIN_ATENCION =
  'Ahora mismo no puedo completar esta consulta automáticamente 🙏 Probá de nuevo en un rato, ' +
  'o dejá tu consulta por acá: el equipo la va a ver en cuanto se conecte.';

/**
 * Review: ¿el turno es una CONSULTA real que merece derivación? Un agradecimiento/ack puro
 * ("gracias", "ok genial", "muchas gracias por todo") tras un flujo determinístico jamás debe
 * activar un takeover — cae al fallback genérico de siempre. Pura y exportada para tests.
 */
export function esConsultaDerivable(text: string): boolean {
  const t = normalizeText(text);
  const sinCortesia = t
    .replace(/\b(muchas|mil|gracias|ok|okey|dale|listo|genial|perfecto|excelente|buenisimo|barbaro|joya|de nada|igualmente|saludos|chau|adios|nos vemos|hasta (luego|manana)|por todo|todo bien|no)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (sinCortesia.length < 4) return false; // ack/cortesía pura
  return /\?/.test(text) || t.length >= 15;
}

/**
 * Deriva a un vendedor activo del TENANT (config propia, jamás de otro tenant) por IA no
 * disponible. La confirmación "Te paso con…" solo se emite si el takeover PERSISTIÓ.
 * Cualquier falla real (config/transacción) devuelve el mensaje temporal honesto — jamás
 * revienta el turno ni deja al cliente sin respuesta (review: la excepción propagada marcaba
 * el evento 'failed' y el cliente no recibía NADA).
 */
export async function derivarPorIaNoDisponible(
  tenantId: string,
  customerId: string,
  input: DerivarIaNoDisponibleInput = {},
  deps: DerivarIaNoDisponibleDeps = defaultDeps,
): Promise<DerivarIaNoDisponibleResult> {
  const cliente = `…${customerId.slice(-4)}`; // logs sin teléfono completo
  try {
    return await derivarInterno(tenantId, customerId, input, deps, cliente);
  } catch {
    logger.warn('IA no disponible: la derivación falló — respuesta temporal sin promesa', { tenantId, customer: cliente });
    return { takeover: false, reply: SIN_ATENCION };
  }
}

async function derivarInterno(
  tenantId: string,
  customerId: string,
  input: DerivarIaNoDisponibleInput,
  deps: DerivarIaNoDisponibleDeps,
  cliente: string,
): Promise<DerivarIaNoDisponibleResult> {
  const config = await deps.getConfig(tenantId);
  // Igual que HANDOFF-2: los placeholders del seed jamás cuentan como vendedores reales.
  const activos = config.sellers.filter((s) => s.active && !!s.name && !/REEMPLAZAR/i.test(s.name));

  // Vendedor: el asignado vigente si sigue activo; si no, el default del tenant (primer activo).
  const asignado = await deps.getAssignedSellerName(tenantId, customerId).catch(() => null);
  const vendedor =
    (asignado ? activos.find((s) => normalizeText(s.name) === normalizeText(asignado)) : undefined) ??
    activos[0] ??
    null;

  if (!vendedor) {
    logger.warn('IA no disponible y SIN vendedor activo para derivar', { tenantId, customer: cliente });
    if (!input.simulation) {
      // Anti-flood (review): sin takeover que silencie los turnos siguientes, un aviso POR WAMID
      // inundaría la campana mientras dure la cuota agotada — acá el aviso es 1 por cliente POR DÍA.
      const bucketDia = `sin-vendedor-${new Date().toISOString().slice(0, 10)}`;
      await deps.notify(tenantId, customerId, null, bucketDia, 'ai_unavailable').catch(() => false);
    }
    return { takeover: false, reply: SIN_ATENCION };
  }

  const reply = `Ahora mismo no puedo completar esta consulta automáticamente. Te paso con ${vendedor.name} para que pueda ayudarte 🙌`;

  if (input.simulation) {
    // Herramientas internas (chat de prueba / test cases): mismo texto, cero efectos operativos.
    return { takeover: true, reply };
  }

  const r = await deps.handoff(tenantId, customerId, {
    reason: 'ai_unavailable',
    sellerName: vendedor.name,
    sourceId: input.messageId ?? null,
    createSessionIfMissing: true,
  });
  if (!r.ok) {
    logger.warn('IA no disponible: la transición a humano no persistió', { tenantId, customer: cliente });
    return { takeover: false, reply: SIN_ATENCION }; // jamás "te paso con…" sin persistencia
  }
  if (r.already) {
    // Ya estaba en atención humana (carrera/duplicado): silencio, sin re-aviso.
    return { takeover: true, reply: '' };
  }
  await deps.notify(tenantId, customerId, vendedor.name, input.messageId ?? null, 'ai_unavailable').catch(() => false);
  logger.info('IA no disponible → handoff persistido', { tenantId, customer: cliente, seller: vendedor.name });
  return { takeover: true, reply };
}
