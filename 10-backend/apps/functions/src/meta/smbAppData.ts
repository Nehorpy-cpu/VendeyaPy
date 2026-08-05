/**
 * meta/smbAppData.ts — EL DISPARO. Sin esto no llega un solo webhook de historial (ADR-0017 §5)
 * ==============================================================================================
 * El §4 del ADR daba por sentado que los webhooks de `history` y `smb_app_state_sync` llegarían por
 * el hecho de estar suscritos. El contrato oficial, verificado el 2026-08-04, dice que NO: hay que
 * pedirlos explícitamente con `POST /<PHONE_NUMBER_ID>/smb_app_data`, primero con
 * `sync_type: "smb_app_state_sync"` y después con `sync_type: "history"`.
 *
 * Y se puede hacer UNA SOLA VEZ. Por eso este módulo no decide nada por su cuenta: el permiso para
 * disparar lo reclama `historyCoordinator.ts` en una transacción, ANTES de tocar Graph.
 *
 * EL TOKEN ES EL DE ESA CONEXIÓN. `resolveTenantWhatsappCredsFor` resuelve el asset del PNID → su
 * conexión (`wa_{pnid}`) → su secreto. Nunca el de `main`: pedir el historial de un número con la
 * credencial de otro es, en el mejor caso, un error de Graph.
 *
 * EL PRINCIPAL NO SE SINCRONIZA POR ACÁ, y no es una limitación técnica sino la restricción del
 * programa: pedir el historial dispara una avalancha de webhooks sobre el número que está
 * vendiendo AHORA, y esa avalancha no se puede cancelar ni deshacer. Si algún día el número
 * principal ENTRA por Coexistence, esa es una decisión aparte y documentada, no un efecto lateral.
 */
import type { MetaAsset } from '@vpw/shared';
import { Timestamp } from 'firebase-admin/firestore';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { resolveTenantWhatsappCredsFor } from '../messaging/resolveWhatsappCreds.js';
import { esNumeroPrincipal } from './multiNumber.js';
import { whatsappIndexId } from './pnidOwnership.js';
import { SMB_APP_DATA_SYNC_TYPES, type MetaGraphClient, type SmbAppDataSyncType } from './graphClient.js';
import {
  coexistenceHistorySyncPath,
  leerCoordinador,
  puedeDisparar,
  reclamarDisparo,
  registrarResultadoDelDisparo,
  type HistorySyncDoc,
  type HistorySyncStatus,
  type MotivoDeRechazo,
} from './historyCoordinator.js';

/**
 * Marca `expired` — el mismo desenlace que dejaría el reclamo al rechazar por vencido.
 *
 * (correctivo H10) Read+decisión+escritura en UNA transacción, exigiendo la generación que vio el
 * precheck (CAS). El merge ciego posterior a una lectura suelta podía aterrizar sobre la generación
 * N+1 abierta EN EL MEDIO por un re-onboarding legítimo — y vencer una ventana de 24 h que recién
 * nacía, sin usarse. Si la vigente ya es otra, o el vencimiento dejó de ser cierto con la lectura
 * fresca, no se escribe nada (la nota del reclamo en `reclamarDisparo` no necesita esto: su rama
 * `vencido` lee y escribe dentro de la MISMA transacción, así que la contención del SDK ya la cerca).
 */
async function marcarVencido(tenantId: string, phoneNumberId: string, generacionLeida: number, nowMs: number): Promise<void> {
  const ref = db().doc(coexistenceHistorySyncPath(tenantId, phoneNumberId));
  await db().runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
    if (!previo) return; // sin coordinador no hay ventana que vencer
    if ((previo.syncGeneration ?? 1) !== generacionLeida) {
      logger.warn('smbAppData: el vencimiento visto por el precheck es de una generación superada; no se marca', {
        tenantId, generacionLeida, generacionVigente: previo.syncGeneration ?? 1,
      });
      return;
    }
    // La decisión se re-deriva sobre la lectura DE ESTA transacción: si otra escritura concurrente
    // movió el estado, el SDK reintenta el cuerpo con la lectura fresca y la decisión se rehace.
    if (puedeDisparar(previo, nowMs).motivo !== 'vencido') return;
    tx.set(
      ref,
      { status: 'expired' satisfies HistorySyncStatus, errorMessage: 'venció la ventana de 24 h sin disparar', updatedAt: Timestamp.fromMillis(nowMs) },
      { merge: true },
    );
  });
}

export type DisparoFallo = MotivoDeRechazo | 'es_numero_principal' | 'sin_credenciales' | 'graph_error';

export type DisparoResultado =
  | { ok: true; syncTypes: SmbAppDataSyncType[] }
  | { ok: false; motivo: DisparoFallo; explicacion: string; syncTypes: SmbAppDataSyncType[] };

/**
 * Las dos llamadas a Graph, en el ORDEN del contrato: primero la agenda del vendedor, después el
 * historial. `syncTypes` devuelve lo que efectivamente se llegó a pedir — si la segunda falla, la
 * primera ya ocurrió y el coordinador tiene que poder decirlo.
 */
export async function pedirSmbAppData(
  phoneNumberId: string,
  accessToken: string,
  graph: MetaGraphClient,
): Promise<{ ok: boolean; syncTypes: SmbAppDataSyncType[]; error?: string }> {
  const hechos: SmbAppDataSyncType[] = [];
  for (const syncType of SMB_APP_DATA_SYNC_TYPES) {
    const r = await graph.requestSmbAppData(phoneNumberId, syncType, accessToken);
    if (!r.ok) return { ok: false, syncTypes: hechos, error: r.error ?? `fallo_${syncType}` };
    hechos.push(syncType);
  }
  return { ok: true, syncTypes: hechos };
}

/** ¿Este PNID es el número principal del tenant? Lee las dos fuentes, igual que el alta. */
async function esElPrincipal(tenantId: string, phoneNumberId: string): Promise<boolean> {
  const asset = (await db().doc(paths.metaAsset(tenantId, phoneNumberId)).get()).data() as MetaAsset | undefined;
  const indice = (await db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId))).get()).data() as
    | { connectionId?: unknown }
    | undefined;
  return esNumeroPrincipal(asset, indice);
}

/**
 * EL ÚNICO camino para disparar la sincronización. El orden importa y es el que impide el doble
 * disparo:
 *
 *   1. guard del número principal (nunca sobre el que vende),
 *   2. RECLAMO transaccional del disparo (`pending_request` → `requested`),
 *   3. credenciales de ESA conexión,
 *   4. las dos llamadas a Graph,
 *   5. resultado persistido.
 *
 * El reclamo va ANTES de Graph a propósito: dos invocaciones concurrentes se resuelven en el paso
 * 2 y sólo una llega al 4. Si el paso 3 o el 4 fallan, el coordinador queda en `failed` y NO se
 * reintenta — no hay forma de saber si Meta recibió el pedido, y un segundo intento sobre uno que
 * sí llegó consume el único disparo que existía.
 */
export async function ejecutarSincronizacionDeHistorial(
  tenantId: string,
  phoneNumberId: string,
  graph: MetaGraphClient,
  nowMs: number,
): Promise<DisparoResultado> {
  if (await esElPrincipal(tenantId, phoneNumberId)) {
    return {
      ok: false,
      motivo: 'es_numero_principal',
      explicacion: 'Ese es el número principal de la empresa: pedir su historial volcaría una avalancha de webhooks sobre el número que está vendiendo, y no se puede cancelar.',
      syncTypes: [],
    };
  }

  /**
   * El VENCIMIENTO se chequea antes que las credenciales: los dos son fallos locales, pero el
   * vencimiento es TERMINAL y determinístico — «arreglá el token» sería el diagnóstico equivocado
   * para una ventana que ya murió. El coordinador queda marcado `expired` igual que lo haría el
   * reclamo, para que el panel no muestre un `pending_request` imposible.
   */
  const coordPrevio = await leerCoordinador(tenantId, phoneNumberId);
  const preVeredicto = puedeDisparar(coordPrevio, nowMs);
  if (!preVeredicto.puede && preVeredicto.motivo === 'vencido') {
    // La generación LEÍDA viaja al marcado (H10): el veredicto vale para ese ciclo y ningún otro.
    await marcarVencido(tenantId, phoneNumberId, coordPrevio?.syncGeneration ?? 1, nowMs);
    return { ok: false, motivo: 'vencido', explicacion: preVeredicto.explicacion, syncTypes: [] };
  }

  /**
   * Correctivo (MEDIO 14): las credenciales se resuelven ANTES de reclamar. Son una precondición
   * PURAMENTE LOCAL — con Meta probadamente sin enterarse de nada — y consumían el único disparo
   * de la vida del número por un token vencido o una conexión a medio migrar. El orden
   * reclamar-antes-de-llamar sigue intacto para lo que SÍ es ambiguo: la llamada Graph en sí,
   * donde no hay forma de saber si Meta la recibió.
   */
  const creds = await resolveTenantWhatsappCredsFor(tenantId, phoneNumberId);
  if (!creds.ok) {
    return {
      ok: false,
      motivo: 'sin_credenciales',
      explicacion: `No se pudo resolver la credencial de ese número (${creds.reason}). El disparo NO se consumió: arreglá la conexión y volvé a intentar.`,
      syncTypes: [],
    };
  }

  const reclamo = await reclamarDisparo(tenantId, phoneNumberId, nowMs);
  if (!reclamo.ok) return { ok: false, motivo: reclamo.motivo, explicacion: reclamo.explicacion, syncTypes: [] };

  const pedido = await pedirSmbAppData(phoneNumberId, creds.accessToken, graph);
  // La generación RECLAMADA viaja al settlement (H8): si un re-onboarding abrió la N+1 mientras
  // Graph estaba en vuelo, este desenlace pertenece a la N y no puede escribir sobre la nueva.
  await registrarResultadoDelDisparo(tenantId, phoneNumberId, reclamo.syncGeneration, pedido, nowMs);
  if (!pedido.ok) {
    logger.warn('smbAppData: el disparo del historial falló', { tenantId, syncTypes: pedido.syncTypes, error: pedido.error });
    return {
      ok: false,
      motivo: 'graph_error',
      explicacion: `Meta rechazó el pedido (${pedido.error ?? 'desconocido'}). No se puede reintentar: hay que offboardear el número y rehacer el Embedded Signup.`,
      syncTypes: pedido.syncTypes,
    };
  }
  logger.info('smbAppData: sincronización pedida', { tenantId, syncTypes: pedido.syncTypes });
  return { ok: true, syncTypes: pedido.syncTypes };
}
