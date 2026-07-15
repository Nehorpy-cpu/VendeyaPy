/**
 * conversation/humanRequest.ts — HANDOFF-2: el CLIENTE pide hablar con una persona
 * =================================================================================
 * El bug de prod: "Quiero hablar con Aaron Sosa nuevamente" fue a la IA, que PROMETIÓ el pase
 * ("Un segundo que lo llamo 👍") sin que exista ningún camino de código que lo ejecute —
 * `humanTakeover` quedó en false y el vendedor jamás se enteró.
 *
 * Acá la detección es DETERMINÍSTICA y corre ANTES de la IA: pedido genérico ("quiero hablar
 * con una persona", "pasame con alguien") o por NOMBRE configurado del tenant. La transición
 * real la hace `executeHandoff` (transaccional + idempotente) y la confirmación al cliente
 * sale recién DESPUÉS de persistir. Nada depende de la respuesta del modelo.
 *
 * Sin nombres/tenants hardcodeados: los vendedores salen de la config del tenant
 * (`config/checkout.sellers`) y la comparación es normalizada (tildes/mayúsculas/puntuación).
 */

import type { Seller } from '@vpw/shared';
import { normalizeText } from '../catalog/match.js';
import { getCheckoutConfig } from '../orders/checkoutConfig.js';
import { executeHandoff, notifyHandoffRequested } from './handoff.js';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

/** Verbo de CONTACTO: hablar/pasar/derivar/atender/llamar/escribir/comunicar… */
const CONTACTO = /\b(habl[aoe]\w*|charl[aoe]\w*|convers[aoe]\w*|comunic[aoe]\w*|contact[aoe]\w*|pasame|pasenme|pasarme|pases con|pasa(r|s)? con|deriv[aoe]\w*|transfer[ií]\w*|atiend[aoe]\w*|atender?me|atencion humana|llam[aoe]\w*|escrib[aoe]\w*)\b/;

/** Marcador de SOLICITUD (deseo/imperativo/pregunta de posibilidad) — evita menciones al pasar. */
const SOLICITUD = /\b(quiero|quisiera|necesito|me gustaria|prefiero|exijo|dame|dejame|se puede|hay forma|podes|podras|podrias?|puedo|puede[sn]?|pasame|pasenme|comunicame|conectame|contactame|derivame|atendeme|atiendanme|llamame|que me (llame|atienda|escriba|contacte|hable))\b/;

/** Destinatario HUMANO genérico. */
const HUMANO = /\b(persona|personas|humano|humana|alguien|gente|ustedes|uds|vendedor|vendedora|vendedores|asesor|asesora|agente|encargad[oa]|due[nñ][oa]|responsable|equipo|staff|operador|operadora|ser humano|gente real|persona real|atencion humana)\b/;

/** Pedido directo SIN verbo de contacto: "quiero un humano", "necesito un vendedor", "dame un asesor". */
const PEDIDO_DIRECTO = /\b(quiero|necesito|quisiera|prefiero|exijo|dame|busco)\s+(?:hablar\s+)?(?:con\s+)?(?:un[a]?\s+|el\s+|la\s+)?(humano|humana|persona(?:\s+real)?|vendedor|vendedora|asesor|asesora|agente|operador|operadora|atencion humana)\b/;

/**
 * Normalización que CONSERVA la puntuación de cláusula (.,;!?) — la negación solo puede
 * gobernar dentro de su propia cláusula ("No, quiero hablar con una persona" SÍ deriva;
 * "no quiero que me pases" NO). `normalizeText` borra la puntuación y no sirve acá.
 */
function normalizarConClausulas(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.,;!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cláusula (entre .,;!?) que contiene el índice dado, con su posición de inicio. */
function clausulaEn(t: string, idx: number): { texto: string; ini: number } {
  const ini = Math.max(t.lastIndexOf('.', idx), t.lastIndexOf(',', idx), t.lastIndexOf(';', idx), t.lastIndexOf('!', idx), t.lastIndexOf('?', idx)) + 1;
  let fin = t.length;
  for (const sep of ['.', ',', ';', '!', '?']) {
    const p = t.indexOf(sep, idx);
    if (p !== -1 && p < fin) fin = p;
  }
  return { texto: t.slice(ini, fin), ini };
}

/** Pre-filtro PURO y barato: ¿este turno podría ser un pedido de humano? (evita leer config). */
export function esPosiblePedidoHumano(text: string): boolean {
  const tc = normalizarConClausulas(text);
  const m = CONTACTO.exec(tc) ?? PEDIDO_DIRECTO.exec(tc);
  if (!m) return false;
  // La negación solo veta dentro de SU cláusula ("no necesito hablar…" NO deriva); una negación
  // en otra cláusula/oración no ("No, quiero hablar con una persona" SÍ deriva).
  const clausula = clausulaEn(tc, m.index);
  const antesEnClausula = clausula.texto.slice(0, Math.max(0, m.index - clausula.ini));
  if (/\b(no|nunca|tampoco|jamas|nada de|deja de)\b/.test(antesEnClausula)) return false;
  if (/\b(nadie|ninguna persona)\b/.test(clausula.texto)) return false; // "…con nadie" jamás deriva
  const t = normalizeText(text);
  return SOLICITUD.test(t) || PEDIDO_DIRECTO.test(t);
}

export type PedidoHumano =
  | { tipo: 'generico' }
  | { tipo: 'nombre'; vendedoresQueMatchean: string[] }
  | { tipo: 'desconocido'; nombre: string };

/** Tokens con poder identificatorio de un nombre configurado (≥3 chars). */
function tokensNombre(nombre: string): string[] {
  return normalizeText(nombre).split(' ').filter((x) => x.length >= 3);
}

/**
 * ¿El texto PIDE a este vendedor? El nombre debe venir introducido por "con/a/al" (review:
 * un token suelto del nombre en cualquier parte colisionaba con marcas/productos del dominio).
 */
function mencionaVendedor(t: string, nombre: string): boolean {
  const prefijo = '\\b(?:con|al?)\\s+(?:el\\s+|la\\s+|se[nñ]orita\\s+|se[nñ]ora?\\s+|don\\s+|do[nñ]a\\s+)?';
  const completo = normalizeText(nombre);
  if (completo && new RegExp(`${prefijo}${completo.replace(/\s+/g, '\\s+')}\\b`).test(t)) return true;
  return tokensNombre(nombre).some((tok) => new RegExp(`${prefijo}(?:[a-z]+\\s+){0,2}?${tok}\\b`).test(t));
}

/**
 * Detección PURA del pedido. Devuelve null si no es un pedido de humano (negaciones,
 * menciones al pasar sin solicitud, o sin destinatario humano/nombre reconocible).
 */
export function detectarPedidoHumano(text: string, nombresConfigurados: string[]): PedidoHumano | null {
  if (!esPosiblePedidoHumano(text)) return null;
  const t = normalizeText(text);
  const nombrados = nombresConfigurados.filter((n) => mencionaVendedor(t, n));
  if (nombrados.length > 0) return { tipo: 'nombre', vendedoresQueMatchean: nombrados };
  if (HUMANO.test(t)) return { tipo: 'generico' };
  // Nombre PROPIO no configurado ("quiero hablar con Juancho"): honestidad, jamás elegir a otro
  // en silencio ni dejar que la IA prometa. Se detecta por mayúscula inicial en el texto CRUDO.
  const propio = /\bcon\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\b/.exec(text);
  if (propio) return { tipo: 'desconocido', nombre: propio[1]! };
  return null; // pidió contactar algo que no es una persona configurada ni un humano genérico
}

export type ResolucionVendedor =
  | { tipo: 'ok'; vendedor: Seller }
  | { tipo: 'inactivo'; nombre: string }
  | { tipo: 'ambiguo'; nombres: string[] }
  | { tipo: 'sin_vendedores' };

/**
 * Resolución PURA del vendedor destino, SOLO dentro del tenant:
 *  - por nombre: únicamente vendedores configurados; activo único → ok; varios → ambiguo;
 *    solo inactivos → inactivo (jamás se elige otro en silencio).
 *  - genérico: el asignado actual si sigue activo → el mecanismo default (primer activo).
 */
export function resolverVendedor(
  sellers: Seller[],
  pedido: Exclude<PedidoHumano, { tipo: 'desconocido' }>,
  asignadoNombre?: string | null,
): ResolucionVendedor {
  const activos = sellers.filter((s) => s.active);
  if (pedido.tipo === 'nombre') {
    const matchActivos = activos.filter((s) => pedido.vendedoresQueMatchean.includes(s.name));
    if (matchActivos.length === 1) return { tipo: 'ok', vendedor: matchActivos[0]! };
    if (matchActivos.length > 1) return { tipo: 'ambiguo', nombres: matchActivos.map((s) => s.name) };
    return { tipo: 'inactivo', nombre: pedido.vendedoresQueMatchean[0]! };
  }
  if (activos.length === 0) return { tipo: 'sin_vendedores' };
  if (asignadoNombre) {
    const asignado = activos.find((s) => normalizeText(s.name) === normalizeText(asignadoNombre));
    if (asignado) return { tipo: 'ok', vendedor: asignado };
  }
  return { tipo: 'ok', vendedor: activos[0]! }; // mismo default que pickSeller (primer activo)
}

export interface ProcesarPedidoHumanoInput {
  /** wamid del inbound (idempotencia del aviso). Sin él (dev), el aviso no deduplica. */
  messageId?: string | null;
}
export interface ProcesarPedidoHumanoResult {
  /** false = este turno NO es un pedido de humano → sigue el ruteo normal. */
  handled: boolean;
  /** true = el takeover quedó PERSISTIDO (la confirmación se envía después, por el pipeline). */
  takeover: boolean;
  reply: string;
}

export interface ProcesarPedidoHumanoDeps {
  getConfig: typeof getCheckoutConfig;
  handoff: typeof executeHandoff;
  notify: typeof notifyHandoffRequested;
  getAssignedSellerName: (tenantId: string, customerId: string) => Promise<string | null>;
}
const defaultDeps: ProcesarPedidoHumanoDeps = {
  getConfig: getCheckoutConfig,
  handoff: executeHandoff,
  notify: notifyHandoffRequested,
  getAssignedSellerName: async (tenantId, customerId) => {
    const snap = await db().doc(paths.customer(tenantId, customerId)).get();
    return (snap.data()?.assignedSellerName as string | undefined) ?? null;
  },
};

const NO_HANDLED: ProcesarPedidoHumanoResult = { handled: false, takeover: false, reply: '' };

/**
 * Orquestación del pedido de humano: detectar → resolver vendedor → transición REAL →
 * confirmar. Si la transición NO persiste, la respuesta jamás promete un pase.
 */
export async function procesarPedidoHumano(
  tenantId: string,
  customerId: string,
  text: string,
  input: ProcesarPedidoHumanoInput = {},
  deps: ProcesarPedidoHumanoDeps = defaultDeps,
): Promise<ProcesarPedidoHumanoResult> {
  if (!esPosiblePedidoHumano(text)) return NO_HANDLED;
  const config = await deps.getConfig(tenantId);
  // Los PLACEHOLDERS del seed ("REEMPLAZAR-…") jamás cuentan como vendedores configurados —
  // sin esto, un tenant sin config derivaba al cliente a "REEMPLAZAR-Vendedor" (review).
  const sellersReales = config.sellers.filter((s) => !!s.name && !/REEMPLAZAR/i.test(s.name));
  const pedido = detectarPedidoHumano(text, sellersReales.map((s) => s.name));
  if (!pedido) return NO_HANDLED;

  // El log jamás lleva el texto del mensaje ni el teléfono completo.
  const cliente = `…${customerId.slice(-4)}`;

  if (pedido.tipo === 'desconocido') {
    logger.info('Pedido de humano: nombre no configurado', { tenantId, customer: cliente });
    return {
      handled: true,
      takeover: false,
      reply:
        `No tengo a nadie llamado ${pedido.nombre} en el equipo 🙏 Si querés hablar con una persona, ` +
        'decime que querés hablar con un vendedor y te paso con quien esté disponible.',
    };
  }

  const asignado = await deps.getAssignedSellerName(tenantId, customerId).catch(() => null);
  const res = resolverVendedor(sellersReales, pedido, asignado);

  if (res.tipo === 'ambiguo') {
    return {
      handled: true,
      takeover: false,
      // Respuesta accionable: la re-respuesta natural ("quiero hablar con X Y") re-entra al detector.
      reply: `Tenemos más de una persona con ese nombre (${res.nombres.join(', ')}) 🙂 Decime, por ejemplo: "quiero hablar con ${res.nombres[0]}".`,
    };
  }
  if (res.tipo === 'inactivo') {
    logger.info('Pedido de humano: vendedor no disponible', { tenantId, customer: cliente, motivo: 'inactivo_o_desconocido' });
    return {
      handled: true,
      takeover: false,
      reply:
        `${res.nombre} no está disponible por acá en este momento 🙏 Si querés hablar con una persona, ` +
        'decime que querés hablar con un vendedor y te paso con quien esté disponible.',
    };
  }
  if (res.tipo === 'sin_vendedores') {
    logger.warn('Pedido de humano SIN vendedores disponibles', { tenantId, customer: cliente });
    // Para que "el equipo ve esta conversación" sea VERDAD aunque no haya vendedor configurado:
    // se avisa igual a la campana del panel (idempotente por wamid), sin prometer un pase.
    await deps.notify(tenantId, customerId, null, input.messageId ?? null).catch(() => false);
    return {
      handled: true,
      takeover: false,
      reply:
        'Ahora mismo no tengo una persona disponible para pasarte 🙏 Dejame tu consulta por acá: ' +
        'el equipo ve esta conversación y te responde en cuanto se conecte.',
    };
  }

  // Transición REAL — la confirmación solo se emite si ESTO persistió.
  const r = await deps.handoff(tenantId, customerId, {
    reason: 'customer_requested',
    sellerName: res.vendedor.name,
    sourceId: input.messageId ?? null,
    createSessionIfMissing: true,
  });
  if (!r.ok) {
    logger.warn('Pedido de humano: la transición no persistió', { tenantId, customer: cliente });
    return {
      handled: true,
      takeover: false,
      reply: 'No pude pasarte con una persona en este momento 🙏 Volvé a intentarlo en un ratito, o dejame tu consulta por acá.',
    };
  }
  if (r.already) {
    // Ya estaba en atención humana (mensaje repetido/carrera): sin nueva confirmación ni aviso.
    return { handled: true, takeover: true, reply: '' };
  }
  await deps.notify(tenantId, customerId, res.vendedor.name, input.messageId ?? null);
  logger.info('Handoff por pedido del cliente PERSISTIDO', { tenantId, customer: cliente, seller: res.vendedor.name });
  return {
    handled: true,
    takeover: true,
    reply: `Listo ✅ Te paso con ${res.vendedor.name}: el asistente queda en pausa y te escribe por acá en cuanto se conecte 🙌`,
  };
}
