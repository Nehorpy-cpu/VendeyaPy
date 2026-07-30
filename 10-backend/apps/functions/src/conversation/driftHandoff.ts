/**
 * conversation/driftHandoff.ts — Derivación por DERIVA CRÍTICA del catálogo (ADR-0015 §8)
 * ========================================================================================
 * Cuando el precio / la disponibilidad / el stock público de un producto los gobierna una fuente
 * externa que hoy publica otra cosa, el bot NO afirma el dato, NO crea la orden y NO manda datos
 * bancarios: deriva a una persona por el servicio CANÓNICO de HANDOFF-2 (`executeHandoff`, razón
 * `catalog_drift`) con aviso idempotente, conservando carrito y conversación.
 *
 * Idempotencia: el `sourceId` es la DERIVA, no el mensaje (`deriva-{ids de producto ordenados}`).
 * Así, dos turnos seguidos sobre el mismo producto —o un webhook repetido— generan UN solo aviso;
 * y una vez persistido el takeover, `handleMessage` ni siquiera vuelve a evaluar el guard.
 *
 * Lo que el cliente lee jamás menciona el precio en disputa, la fuente externa, el feed, Meta ni
 * ningún detalle interno: solo que hace falta confirmarlo con una persona.
 */

import type { VeredictoDeriva } from '../catalog/driftGuard.js';
import { resumenSaneado } from '../catalog/driftGuard.js';
import { normalizeText } from '../catalog/match.js';
import { getCheckoutConfig } from '../orders/checkoutConfig.js';
import { executeHandoff, notifyHandoffRequested } from './handoff.js';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

export interface DerivarPorDerivaInput {
  /** wamid del inbound: solo para trazas; la idempotencia va por la deriva, no por el mensaje. */
  messageId?: string | null;
  /** Simulador del panel / test cases: mismo texto, CERO efectos operativos. */
  simulation?: boolean;
}

export interface DerivarPorDerivaResult {
  /** true = takeover persistido (o simulado): el caller responde DESPUÉS de esto. */
  takeover: boolean;
  reply: string;
}

export interface DerivarPorDerivaDeps {
  getConfig: typeof getCheckoutConfig;
  handoff: typeof executeHandoff;
  notify: typeof notifyHandoffRequested;
  getAssignedSellerName: (tenantId: string, customerId: string) => Promise<string | null>;
}
const defaultDeps: DerivarPorDerivaDeps = {
  getConfig: getCheckoutConfig,
  handoff: executeHandoff,
  notify: notifyHandoffRequested,
  getAssignedSellerName: async (tenantId, customerId) => {
    const snap = await db().doc(paths.customer(tenantId, customerId)).get();
    return (snap.data()?.assignedSellerName as string | undefined) ?? null;
  },
};

/** Hasta 3 nombres en el texto: más que eso no ayuda a nadie y ensucia el mensaje. */
function listarNombres(nombres: readonly string[]): string {
  const vistos = [...new Set(nombres.filter((n) => !!n && !!n.trim()))].slice(0, 3);
  if (!vistos.length) return 'algunos productos de tu pedido';
  const marcados = vistos.map((n) => `*${n}*`);
  if (marcados.length === 1) return marcados[0]!;
  return `${marcados.slice(0, -1).join(', ')} y ${marcados[marcados.length - 1]}`;
}

/**
 * Mensaje al cliente. PURO y exportado para tests. Invariantes: no afirma ni niega un precio,
 * no da un número, no promete stock y no menciona sistemas internos. Con vendedor promete el
 * pase (que el caller solo emite si el takeover PERSISTIÓ); sin vendedor, no promete a nadie.
 */
export function mensajeDeriva(nombres: readonly string[], vendedor: string | null): string {
  const que = listarNombres(nombres);
  return vendedor
    ? `Antes de avanzar prefiero confirmarte el precio y la disponibilidad de ${que} 🙏 Te paso con ${vendedor} para que te lo confirme. Tu carrito queda guardado.`
    : `Antes de avanzar necesito confirmar el precio y la disponibilidad de ${que} 🙏 El equipo lo está revisando y te confirmamos por acá. Tu carrito queda guardado.`;
}

/** Sin nadie a quien derivar: honestidad sin promesa (mismo criterio que AI-FALLBACK-HONESTO-1). */
const SIN_ATENCION_BASE = (nombres: readonly string[]) => mensajeDeriva(nombres, null);

/**
 * Deriva a un vendedor ACTIVO del tenant recibido (jamás de otro) por deriva crítica.
 * Cualquier falla real devuelve el mensaje honesto sin promesa — nunca revienta el turno ni deja
 * al cliente sin respuesta, y NUNCA cotiza el precio en disputa.
 */
export async function derivarPorDerivaCritica(
  tenantId: string,
  customerId: string,
  veredicto: VeredictoDeriva,
  input: DerivarPorDerivaInput = {},
  deps: DerivarPorDerivaDeps = defaultDeps,
): Promise<DerivarPorDerivaResult> {
  const nombres = veredicto.bloqueantes.map((b) => b.productName);
  const cliente = `…${customerId.slice(-4)}`; // logs sin teléfono completo
  if (!veredicto.bloqueantes.length) return { takeover: false, reply: '' };
  try {
    return await derivarInterno(tenantId, customerId, veredicto, input, deps, cliente);
  } catch {
    logger.warn('Deriva de catálogo: la derivación falló — respuesta honesta sin promesa', { tenantId, customer: cliente });
    return { takeover: false, reply: SIN_ATENCION_BASE(nombres) };
  }
}

async function derivarInterno(
  tenantId: string,
  customerId: string,
  veredicto: VeredictoDeriva,
  input: DerivarPorDerivaInput,
  deps: DerivarPorDerivaDeps,
  cliente: string,
): Promise<DerivarPorDerivaResult> {
  const nombres = veredicto.bloqueantes.map((b) => b.productName);
  // La deriva ES el evento: mismo producto ⇒ mismo id ⇒ un solo aviso, aunque el cliente
  // pregunte tres veces o el webhook se repita.
  const sourceId = `deriva-${[...veredicto.bloqueantes.map((b) => b.productId)].sort().join('-')}`;

  const config = await deps.getConfig(tenantId);
  // Igual que HANDOFF-2: los placeholders del seed jamás cuentan como vendedores reales.
  const activos = config.sellers.filter((s) => s.active && !!s.name && !/REEMPLAZAR/i.test(s.name));
  const asignado = await deps.getAssignedSellerName(tenantId, customerId).catch(() => null);
  const vendedor =
    (asignado ? activos.find((s) => normalizeText(s.name) === normalizeText(asignado)) : undefined) ??
    activos[0] ??
    null;

  if (!vendedor) {
    logger.warn('Deriva de catálogo SIN vendedor activo para derivar', { tenantId, customer: cliente, ...resumenSaneado(veredicto) });
    if (!input.simulation) {
      // El aviso igual se emite (el equipo tiene que enterarse), idempotente por la misma deriva.
      await deps.notify(tenantId, customerId, null, sourceId, 'catalog_drift').catch(() => false);
    }
    return { takeover: false, reply: SIN_ATENCION_BASE(nombres) };
  }

  const reply = mensajeDeriva(nombres, vendedor.name);
  if (input.simulation) return { takeover: true, reply }; // chat de prueba: cero efectos

  const r = await deps.handoff(tenantId, customerId, {
    reason: 'catalog_drift',
    sellerName: vendedor.name,
    sourceId,
    createSessionIfMissing: true,
  });
  if (!r.ok) {
    logger.warn('Deriva de catálogo: la transición a humano no persistió', { tenantId, customer: cliente });
    return { takeover: false, reply: SIN_ATENCION_BASE(nombres) }; // jamás "te paso con…" sin persistencia
  }
  if (r.already) {
    // Ya estaba en atención humana (carrera / turno repetido): silencio, sin re-aviso.
    return { takeover: true, reply: '' };
  }
  await deps.notify(tenantId, customerId, vendedor.name, sourceId, 'catalog_drift').catch(() => false);
  logger.info('Deriva de catálogo → handoff persistido', { tenantId, customer: cliente, ...resumenSaneado(veredicto) });
  return { takeover: true, reply };
}
