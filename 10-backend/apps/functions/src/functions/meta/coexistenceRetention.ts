/**
 * functions/meta/coexistenceRetention.ts — Purga del archivo de Coexistence (ADR-0017 §4)
 * ========================================================================================
 * El ADR pide que el historial importado tenga «TTL corto, y su payload se anula al cerrar el
 * evento — el mismo patrón que ya se usa con la ubicación exacta». La política TTL se declara en
 * `firestore.indexes.json`, pero una política es infraestructura: se aplica al desplegar índices y
 * se puede quedar sin aplicar sin que nada falle a la vista. Este barrido es el mecanismo del
 * REPO, y existe por eso — y porque el borrado por TTL de Firestore no es inmediato.
 *
 * QUÉ CIERRA UN EVENTO DEL ARCHIVO. El historial y la agenda del vendedor no tienen consumidor:
 * no pasan por `metaWebhookInbox` justamente para que `onWebhookInbox` no los procese (ADR-0017
 * §12). Su cierre, entonces, es el vencimiento de la retención. Ahí se les anula el payload igual
 * que `process.ts` anula `payload.location` al terminar.
 *
 * LA SUPERFICIE DE OBSERVACIÓN (`metaWebhookShadow`, ADR-0017 §1) entra por lo mismo y por una
 * razón más fuerte: guarda el teléfono del cliente y el TEXTO de los mensajes en campos propios.
 * Nació fuera de esta lista y su `expiresAt` quedó decorativo. Ver `COEXISTENCE_RETENTION_TARGETS`.
 *
 * EL ORDEN ANULAR → BORRAR no es cosmético. Si el borrado falla (contención, permisos, corte de la
 * corrida), el documento ya quedó sin las conversaciones adentro y la próxima pasada solo tiene
 * que barrer una cáscara. Al revés, un borrado fallido dejaría 180 días de chats privados intactos.
 *
 * Cada 6 h y no una vez por día: el TTL del historial es de 48 h y una cadencia diaria estiraría la
 * retención efectiva a 72 h. El costo es dos consultas acotadas por corrida.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { COEXISTENCE_HISTORY_COLLECTION, COEXISTENCE_APP_STATE_COLLECTION } from './webhookHttp.js';
import { COEXISTENCE_SHADOW_COLLECTION } from '../../meta/echoConsumer.js';

/**
 * QUÉ SE ANULA, Y POR QUÉ NO ES LO MISMO EN TODAS. El barrido decía «las dos colecciones del
 * archivo, ninguna otra» y anulaba `payload`. Cuando apareció la superficie de OBSERVACIÓN de
 * `shadow` quedó afuera —dos archivos distintos, tocados en momentos distintos— y su `expiresAt`
 * era decorativo: guardaba el teléfono del cliente y el texto íntegro de los mensajes para siempre.
 *
 * Sumarla a la lista no alcanzaba: en la observación el contenido NO vive en `payload` (ese
 * documento no tiene payload) sino en `text` y `customerId`. Un `payload: null` genérico habría
 * dejado el documento intacto y el barrido habría reportado éxito. Por eso cada destino declara
 * QUÉ campos anula: la anulación tiene que nombrar los campos que realmente guardan el dato.
 */
export interface CoexistenceRetentionTarget {
  collection: string;
  /** Campos que se ANULAN antes de borrar; `corte` es el reloj de la corrida. */
  cierre: (corte: Timestamp) => Record<string, unknown>;
}

/** Cierre de un EVENTO del archivo: la conversación importada vive en `payload`. */
const cierreDeEvento = (corte: Timestamp) => ({
  // Mismo patrón que el cierre de un evento con ubicación en `process.ts`: el payload se anula y
  // el evento queda marcado como cerrado, con el estado de algo que nunca se procesó.
  payload: null,
  processingStatus: 'ignored',
  errorMessage: 'retención vencida: payload anulado',
  processedAt: corte,
});

/** Cierre de una OBSERVACIÓN: el dato sensible son el teléfono y el texto, no un payload. */
const cierreDeObservacion = (corte: Timestamp) => ({
  customerId: null,
  text: null,
  purgedAt: corte,
});

/**
 * Los destinos del barrido. Este job NO toca la bandeja viva (`metaWebhookInbox`), cuyo TTL es
 * política de consola. `coexistenceRetention.costura.test.ts` verifica mecánicamente que esta
 * lista, los `fieldOverrides` de `firestore.indexes.json` y las reglas declaren lo mismo: la lista
 * está escrita a mano y ya se desincronizó una vez.
 */
export const COEXISTENCE_RETENTION_TARGETS: readonly CoexistenceRetentionTarget[] = Object.freeze([
  { collection: COEXISTENCE_HISTORY_COLLECTION, cierre: cierreDeEvento },
  { collection: COEXISTENCE_APP_STATE_COLLECTION, cierre: cierreDeEvento },
  { collection: COEXISTENCE_SHADOW_COLLECTION, cierre: cierreDeObservacion },
]);

/** Sólo los nombres (lo que consumen los chequeos de costura y los logs). */
export const COEXISTENCE_RETENTION_COLLECTIONS: readonly string[] = Object.freeze(
  COEXISTENCE_RETENTION_TARGETS.map((t) => t.collection),
);

/**
 * Tope por colección y por corrida. Acotado a propósito: una sincronización de 180 días puede
 * dejar muchos chunks y una corrida sin techo se pasaría del timeout dejando trabajo a medias.
 * Con cadencia de 6 h, lo que sobre se limpia en la siguiente.
 */
export const COEXISTENCE_PURGE_BATCH_LIMIT = 300;

export interface CoexistenceRetentionSummary {
  /** Documentos vencidos encontrados. */
  escaneados: number;
  /** Documentos cuyo payload quedó ANULADO (lo irreversible, y lo que importa). */
  anulados: number;
  /** Documentos efectivamente borrados. */
  borrados: number;
  /** Documentos que quedaron sin payload pero no se pudieron borrar (se reintentan solos). */
  fallidos: number;
}

/**
 * Barre las dos colecciones y cierra lo vencido. No lanza: un error en una colección no puede
 * dejar la otra sin purgar.
 */
export async function runCoexistenceRetentionPurge(args?: {
  nowMs?: number;
  limit?: number;
}): Promise<CoexistenceRetentionSummary> {
  const nowMs = args?.nowMs ?? Date.now();
  const limit = args?.limit ?? COEXISTENCE_PURGE_BATCH_LIMIT;
  const corte = Timestamp.fromMillis(nowMs);
  const resumen: CoexistenceRetentionSummary = { escaneados: 0, anulados: 0, borrados: 0, fallidos: 0 };

  for (const { collection: coleccion, cierre } of COEXISTENCE_RETENTION_TARGETS) {
    try {
      const vencidos = await db().collection(coleccion).where('expiresAt', '<=', corte).limit(limit).get();
      resumen.escaneados += vencidos.docs.length;
      for (const doc of vencidos.docs) {
        try {
          await doc.ref.update(cierre(corte));
          resumen.anulados += 1;
        } catch (e) {
          // Sin el id del documento: lleva el PNID del negocio y, en la agenda, el wa_id de un contacto.
          logger.error('Coexistence: no se pudo anular el payload de un evento vencido', e, { coleccion });
          resumen.fallidos += 1;
          continue; // sin anular no se borra: hay que poder volver a intentarlo
        }
        try {
          await doc.ref.delete();
          resumen.borrados += 1;
        } catch (e) {
          logger.error('Coexistence: payload anulado pero el documento no se pudo borrar', e, { coleccion });
          resumen.fallidos += 1;
        }
      }
    } catch (e) {
      logger.error('Coexistence: falló el barrido de retención de una colección', e, { coleccion });
    }
  }
  return resumen;
}

export const coexistenceRetentionMaintenance = onSchedule(
  // Horas explícitas y no `5/6`: no se pisan con los mantenimientos existentes (02:40, 03:30,
  // 04:00, 04:30/16:30, 09:00) y se leen sin tener que interpretar el paso.
  { schedule: '20 5,11,17,23 * * *', timeZone: 'America/Asuncion', region: 'us-central1', timeoutSeconds: 300 },
  async () => {
    const r = await runCoexistenceRetentionPurge();
    logger.info('Coexistence: purga de retención terminada', { ...r });
  },
);
