/**
 * onWebhookInbox — Trigger: procesa cada evento nuevo de la bandeja de webhooks (D2)
 * =================================================================================
 * Al crearse un doc en metaWebhookInbox, lo procesa en segundo plano: resuelve la
 * empresa y lo entrega al motor del bot. Ver ADR-0009.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { processWebhookEvent, esReintentoDeWebhook } from '../../meta/process.js';
import { ANTHROPIC_API_KEY } from '../../ai/aiSecret.js';
import { logger } from '../../lib/logger.js';

/**
 * Timeout de la función. Tiene que ser MAYOR que `worstCaseDownloadBudgetMs()` (≈121,5 s) con
 * margen para la subida a Storage, las escrituras de Firestore y el turno del motor. Un test
 * ata los dos números: si mañana se suben los reintentos o los timeouts de `mediaClient`, se
 * pone rojo en vez de dejar la función muriendo a mitad de descarga.
 */
export const ONWEBHOOKINBOX_TIMEOUT_SECONDS = 180;
export const ONWEBHOOKINBOX_MEMORY = '512MiB' as const;

/**
 * ADR-0017 §1 — REENTREGA DEL EVENTO. La otra mitad del reintento de `process.ts`.
 *
 * Este trigger es `onDocumentCreated`: reescribir un documento que ya existe no lo vuelve a
 * disparar, y no hay ningún barrido programado sobre `metaWebhookInbox`. O sea que devolver el
 * evento a la cola solo sirve si la CORRIDA FALLA y la plataforma lo reentrega — y sin `retry`
 * declarado, una corrida fallida se descarta y el mensaje del cliente se pierde en silencio.
 *
 * Habilitarlo NO le cambia el camino a nadie más: la única excepción que se deja escapar es la
 * TIPADA (`esReintentoDeWebhook`), que `process.ts` lanza a propósito y con presupuesto acotado.
 * Todo otro error se sigue tragando exactamente como antes, así que ningún camino que hoy termina
 * en `failed` pasa a reintentarse.
 */
export const ONWEBHOOKINBOX_RETRY = true;

/**
 * TIMEOUT y MEMORIA explícitos (ADR-0016). Los defaults de gen2 —60 s y 256 MiB— no alcanzan para
 * el peor caso REAL de esta función desde que ingesta adjuntos:
 *
 *   metadata de Graph      10 s × (1 intento + 2 reintentos) = 30 s
 *   backoff entre intentos 0,25 s + 0,50 s                   ≈  0,75 s
 *   contenido del media    30 s × (1 intento + 2 reintentos) = 90 s
 *   backoff entre intentos 0,25 s + 0,50 s                   ≈  0,75 s
 *   ───────────────────────────────────────────────────────────────
 *   presupuesto de descarga                                  ≈ 121,5 s
 *
 * …y encima quedan la subida a Storage, las escrituras de Firestore y —si el mensaje trae
 * caption— el turno del motor. Con 60 s la función moría a mitad de camino y el adjunto quedaba
 * en `downloading` para siempre (por eso además existe el rescate por reintento de la ingesta).
 * 180 s deja ~58 s de margen sobre el presupuesto de descarga sin acercarse al techo de gen2
 * (540 s) ni encarecer el caso normal, que termina en menos de 5 s: el timeout solo se paga
 * cuando algo efectivamente se cuelga.
 *
 * 512 MiB por el buffer: el tope de un adjunto es 10 MiB, pero durante la descarga conviven los
 * chunks del stream y el `Buffer.concat` final (≈2×), más lo que la subida a Storage retiene.
 * 256 MiB es innecesariamente ajustado para eso; 512 MiB es el escalón siguiente y sigue siendo barato.
 */
// Es el camino REAL del bot de WhatsApp (inbound → handleMessage → sales agent IA): bindea el secret
// de Anthropic (least-privilege) para que getAiClient() lo lea en runtime.
export const onWebhookInbox = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'metaWebhookInbox/{eventId}',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: ONWEBHOOKINBOX_TIMEOUT_SECONDS,
    memory: ONWEBHOOKINBOX_MEMORY,
    retry: ONWEBHOOKINBOX_RETRY,
  },
  async (event) => {
    try {
      await processWebhookEvent(event.params.eventId);
    } catch (e) {
      // El pedido de reentrega SALE: la corrida tiene que fallar o no hay reintento (ver
      // ONWEBHOOKINBOX_RETRY). El evento ya quedó `received` y tomable; acá no se toca nada más.
      if (esReintentoDeWebhook(e)) {
        logger.warn('onWebhookInbox: el evento vuelve a la cola; se pide reentrega', { eventId: event.params.eventId });
        throw e;
      }
      logger.error('Error en onWebhookInbox', e, { eventId: event.params.eventId });
    }
  },
);
