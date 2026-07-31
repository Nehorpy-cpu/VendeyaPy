/**
 * conversation/silencio.ts — La regla de silencio de HANDOFF-2, en UN solo lugar (ADR-0016 §12)
 * =============================================================================================
 * «Ninguna respuesta automática sobrevive a un takeover.» Para que eso sea cierto hacen falta dos
 * cosas que antes no existían juntas:
 *
 *  1. Una ÚNICA semántica. La regla (un vendedor tomó el chat, o el bot está apagado desde el
 *     panel) vivía adentro del motor y se reimplementaba a mano en cada borde: el re-chequeo
 *     fresco del motor miraba `humanTakeover` pero ignoraba `botEnabled`, y el camino de
 *     ubicación nativa tenía una tercera versión rama por rama. Tres copias que ya divergían.
 *     Acá vive la regla y de acá la importan todos: el motor, el camino de adjuntos y el de
 *     ubicación. No se agrega una segunda versión, se centraliza la que ya era canónica.
 *
 *  2. Un chequeo AUTORITATIVO e inmediatamente anterior al envío. Entre que se decide una
 *     respuesta y que sale el POST a Meta pasan segundos (IA, transacciones, resolución de
 *     credenciales): en esa ventana un vendedor puede tomar el chat. `evaluarSilencioPreEnvio`
 *     relee el estado REAL en el borde, y lo hace FAIL-CLOSED: si la lectura falla, se calla.
 *     Hablarle encima a un vendedor rompe una garantía que ve el cliente; perder un acuse es
 *     recuperable.
 *
 * Y una tercera, que es del caller: una respuesta SUPRIMIDA no se persiste. Un outbound en el
 * historial que nunca salió le miente al vendedor sobre lo que el cliente vio.
 */

import type { AgentConfig, Session, SessionState } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { getAgentConfig } from './agentConfig.js';

/**
 * ¿El bot tiene que quedarse CALLADO en esta conversación? Es la regla de HANDOFF-2 y vive en un
 * solo lugar a propósito: un vendedor tomó el chat, o el bot está apagado desde el panel.
 */
export const enSilencio = (session: Session | null, agentConfig: AgentConfig): boolean =>
  (session?.context?.humanTakeover ?? false) || !agentConfig.botEnabled;

/**
 * Misma pregunta que la de arriba, pero leyendo el estado REAL (sesión + config del agente).
 *
 * Se exporta porque el camino de ADJUNTOS puede cerrar un turno SIN pasar por el motor —un archivo
 * sin caption no abre turno— y aun así tiene algo que decirle al cliente. Sin esto, el acuse del
 * adjunto salía igual con el chat tomado por un vendedor: reimplementar la regla allá garantizaba
 * que las dos versiones se desincronizaran a la primera condición nueva.
 */
export async function botSilenciadoEnChat(tenantId: string, customerId: string): Promise<boolean> {
  const snap = await db().doc(paths.session(tenantId, customerId)).get();
  return enSilencio(snap.exists ? (snap.data() as Session) : null, await getAgentConfig(tenantId));
}

/**
 * ADR-0016 §12 — Qué espera del silencio el outbound que está por salir. Es un TOKEN y no un
 * booleano porque las dos respuestas automáticas del sistema NO son la misma cosa:
 *
 *  - `requiere_silencio_libre`: respuesta autónoma del bot (acuse de un archivo, catálogo,
 *    carrito, cobertura…). Con el chat tomado o el bot apagado NO sale. Es el default.
 *  - `confirma_handoff_propio`: la confirmación del handoff que ESTE MISMO turno acaba de
 *    persistir («te paso con Ana», «lo estamos revisando»). El chat está en takeover
 *    justamente por este turno: exigirle silencio libre la mataría SIEMPRE y el cliente
 *    quedaría sin la única frase que explica la pausa —el bot pasaría a humano en silencio—.
 *    Sale igual, salvo que el takeover vigente sea AJENO: si `handoffSourceId` ya no es el que
 *    produjo este turno, otro actor tomó el chat en el medio y manda él.
 */
export type ExpectativaDeSilencio =
  | { modo: 'requiere_silencio_libre' }
  | { modo: 'confirma_handoff_propio'; sourceId: string | null };

/** Default explícito: cualquier outbound que no declare otra cosa exige silencio libre. */
export const EXIGE_SILENCIO_LIBRE: ExpectativaDeSilencio = Object.freeze({ modo: 'requiere_silencio_libre' });

export type VeredictoPreEnvio = 'libre' | 'silenciado';

/**
 * ADR-0016 §12 — Descriptor de la burbuja del bot cuando el caller se hace cargo del borde de
 * envío (`deferOutbound`). El productor de la respuesta NO la persiste: devuelve QUÉ habría que
 * escribir y el borde decide, después del chequeo autoritativo y del resultado del transporte,
 * si eso llega o no al historial. El texto no viaja acá a propósito: la única fuente de verdad
 * del texto es el `reply` que se envía, para que no puedan divergir.
 */
export interface OutboundDiferido {
  /**
   * Los tres campos del resumen son OPCIONALES a propósito: `undefined` significa «no tocar».
   * `appendMessage` solo escribe `conversation.state` / `conversation.humanTakeover` cuando
   * vienen definidos, y el acuse de un adjunto —que hoy no manda ninguno— no puede empezar a
   * pisar el flag de takeover del resumen por un descuido de tipos.
   */
  state?: SessionState | null;
  humanTakeover?: boolean;
  /** true = suma 1 a "sin leer" del vendedor (las confirmaciones de handoff lo hacen). */
  countUnread?: boolean;
  expectativa: ExpectativaDeSilencio;
}

/**
 * EL GUARD DEL BORDE DE ENVÍO. Autoritativo (relee sesión + config, no confía en ninguna lectura
 * previa del turno) y pensado para ser la ÚLTIMA operación antes del POST: el caller resuelve
 * credenciales ANTES de llamar acá, para no reabrir la ventana con E/S en el medio.
 *
 * Fail-closed: cualquier error de lectura devuelve 'silenciado'.
 */
export async function evaluarSilencioPreEnvio(
  tenantId: string,
  customerId: string,
  expectativa: ExpectativaDeSilencio = EXIGE_SILENCIO_LIBRE,
): Promise<VeredictoPreEnvio> {
  let session: Session | null;
  let agentConfig: AgentConfig;
  try {
    const [snap, cfg] = await Promise.all([
      db().doc(paths.session(tenantId, customerId)).get(),
      getAgentConfig(tenantId),
    ]);
    session = snap.exists ? (snap.data() as Session) : null;
    agentConfig = cfg;
  } catch (e) {
    logger.error('No se pudo releer el estado de silencio antes del envío; NO se responde', e, { tenantId });
    return 'silenciado';
  }
  if (!enSilencio(session, agentConfig)) return 'libre';
  // Excepción ÚNICA (y acotada): la confirmación del handoff que este turno acaba de persistir.
  // El bot apagado no la habilita —apagar el bot calla TODO— y un takeover de otra fuente tampoco.
  if (expectativa.modo === 'confirma_handoff_propio' && agentConfig.botEnabled) {
    const ctx = session?.context;
    const propio = ctx?.humanTakeover === true && (ctx.handoffSourceId ?? null) === expectativa.sourceId;
    if (propio) return 'libre';
    logger.info('Confirmación de handoff suprimida: el takeover vigente es AJENO a este turno', { tenantId });
  }
  return 'silenciado';
}
