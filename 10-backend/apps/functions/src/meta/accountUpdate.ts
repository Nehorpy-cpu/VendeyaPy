/**
 * meta/accountUpdate.ts — Meta desconecta el número solo, y hay que enterarse (ADR-0017 §6)
 * ==========================================================================================
 * El repo no tenía NINGUNA referencia a `account_update`, `ACCOUNT_OFFBOARDED`, `PARTNER_REMOVED`
 * ni `ACCOUNT_RECONNECTED`. Meta desconecta un número en coexistencia por su cuenta —inactividad
 * del dispositivo primario (~14 d), del companion (~30 d), cambio de número, re-registro,
 * reinstalación o downgrade de la app— y lo avisa por ese webhook. Sin consumirlo, un número en
 * `live` seguiría automatizando contra una conexión muerta: cada inbound gastaría trabajo y cada
 * respuesta fallaría, sin que nada explicara por qué.
 *
 * QUÉ HACE Y QUÉ NO HACE, y el porqué de cada límite:
 *
 *  · **Degrada `automationMode` a `inactive`**, que es exactamente para lo que existe el eje de la
 *    decisión 1. Se escribe en el ASSET y en el ÍNDICE: el desempate es por el más restrictivo, y
 *    escribir en los dos deja el permiso cerrado aunque uno de los dos documentos quede atrás.
 *  · **NO toca `status`, `selected`, `tokenSecretRef`, la conexión ni la entrada de ruteo.** Un
 *    `account_update` dice «este número dejó de estar en coexistencia», no «borrá la conexión».
 *    Revertirlo tiene que ser la escritura de UN campo por un humano, no una reconstrucción.
 *  · **La Deregister API está PROHIBIDA en coexistencia**: desconectar es un acto del cliente desde
 *    su app, nunca nuestro. Este módulo no llama a Graph. Ni una vez.
 *  · **Sin `phone_number_id` no degrada a nadie.** El payload de `account_update` no siempre lo
 *    trae; deducir el número del `phone_number` mostrado o de la WABA podría dejar mudo al número
 *    que está vendiendo, que es el desenlace prohibido de este programa. Se audita y se sigue.
 *
 * `ACCOUNT_RECONNECTED` **no re-otorga permiso**: vuelve a nacer sin automatización (ADR-0017 §6).
 * Que Meta reconecte el canal no es que un humano haya decidido que el bot puede contestar por ahí.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { AUTOMATION_MODE_FAIL_CLOSED } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { whatsappIndexId } from './pnidOwnership.js';
import { cerrarGeneracionPorOffboarding } from './historyCoordinator.js';
import type { AccountUpdateEvent, NormalizedAccountUpdate } from './parseWebhook.js';

/** Los eventos que APAGAN el permiso porque el número dejó de estar conectado. */
const EVENTOS_DE_DESCONEXION: readonly AccountUpdateEvent[] = Object.freeze(['ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED']);

export type AccountUpdateAccion = 'degradado' | 'reconectado_sin_permiso';
export type AccountUpdateOmision = 'sin_pnid' | 'evento_desconocido' | 'sin_tenant' | 'sin_asset' | 'reentrega' | 'error';

export type AccountUpdateResultado =
  | { aplicado: true; accion: AccountUpdateAccion; tenantId: string }
  | { aplicado: false; motivo: AccountUpdateOmision };

/** ¿Este evento apaga el permiso de automatizar? PURA, para poder auditar la regla sin Firestore. */
export function degradaPermiso(event: AccountUpdateEvent): boolean {
  // `ACCOUNT_RECONNECTED` también escribe `inactive`, pero por otra razón (no re-otorgar), así que
  // no comparte esta lista: mezclarlas haría creer que reconectar es una desconexión.
  return EVENTOS_DE_DESCONEXION.includes(event);
}

/**
 * Aplica un `account_update`. No lanza: un webhook que no se puede procesar tiene que responder
 * igual, y perder el evento es preferible a devolver un 500 que haga reintentar a Meta un evento
 * que no cambia nada.
 */
export async function aplicarAccountUpdate(update: NormalizedAccountUpdate, nowMs: number): Promise<AccountUpdateResultado> {
  const pnid = update.externalId.trim();
  if (pnid === '') {
    // Sin PNID no se sabe a quién degradar. Auditar y NO adivinar: silenciar el número equivocado
    // es peor que enterarse tarde de una desconexión.
    logger.warn('accountUpdate: evento sin phone_number_id; no se degrada ningún número', { event: update.event, wabaId: update.wabaId });
    return { aplicado: false, motivo: 'sin_pnid' };
  }
  const esDesconexion = degradaPermiso(update.event);
  const esReconexion = update.event === 'ACCOUNT_RECONNECTED';
  if (!esDesconexion && !esReconexion) {
    logger.warn('accountUpdate: evento no reconocido; sin efecto', { rawEvent: update.rawEvent });
    return { aplicado: false, motivo: 'evento_desconocido' };
  }

  try {
    const idxRef = db().doc(paths.metaExternalIndexEntry(whatsappIndexId(pnid)));
    const idx = (await idxRef.get()).data() as { tenantId?: unknown } | undefined;
    const tenantId = typeof idx?.tenantId === 'string' && idx.tenantId !== '' ? idx.tenantId : '';
    if (!tenantId) {
      logger.warn('accountUpdate: no se pudo resolver la empresa del número', { event: update.event });
      return { aplicado: false, motivo: 'sin_tenant' };
    }
    /**
     * Correctivo (MEDIO 17): DEDUP por evento. Meta reentrega `account_update` (at-least-once), y
     * aplicarlo en cada entrega significaba que un ACCOUNT_OFFBOARDED viejo, reentregado después
     * de que un humano re-promoviera el número, lo degradaba de nuevo Y cerraba una generación que
     * no le pertenecía. La identidad del evento es (pnid, evento, timestamp de Meta): la reentrega
     * trae el MISMO timestamp; una desconexión NUEVA trae otro y aplica normal. El registro es
     * evidencia mínima sin PII (colección Admin-only por default-deny), y no lleva TTL: su volumen
     * es el de las desconexiones reales.
     */
    const dedupId = `au_${pnid}_${update.event}_${Math.round((update.timestamp ?? 0) * 1000)}`;
    try {
      await db().doc(`metaAccountUpdates/${dedupId}`).create({ tenantId, event: update.event, appliedAt: Timestamp.fromMillis(nowMs) });
    } catch (e) {
      const code = (e as { code?: number | string }).code;
      if (code === 6 || code === 'already-exists') {
        logger.info('accountUpdate: reentrega del mismo evento; sin efecto', { tenantId, event: update.event });
        return { aplicado: false, motivo: 'reentrega' };
      }
      throw e;
    }

    const assetRef = db().doc(paths.metaAsset(tenantId, pnid));
    if (!(await assetRef.get()).exists) {
      logger.warn('accountUpdate: el número no tiene asset en esa empresa', { tenantId, event: update.event });
      return { aplicado: false, motivo: 'sin_asset' };
    }

    const now = Timestamp.fromMillis(nowMs);
    // MERGE y sólo los campos del permiso: `status`, `selected`, `connectionId`, `sessionKey` y el
    // secreto quedan como estaban. La reversión es una escritura de un campo, no una reconstrucción.
    const cambio = {
      automationMode: AUTOMATION_MODE_FAIL_CLOSED,
      coexistenceLastAccountEvent: update.event,
      coexistenceLastAccountEventAt: now,
      updatedAt: now,
    };
    const batch = db().batch();
    batch.set(assetRef, cambio, { merge: true });
    // El índice también: el desempate es por el más restrictivo y quien lea sólo el índice tiene
    // que ver el permiso cerrado igual.
    batch.set(idxRef, { automationMode: AUTOMATION_MODE_FAIL_CLOSED, updatedAt: now }, { merge: true });
    await batch.commit();

    // Un offboarding también cierra la generación VIGENTE del historial (si no era terminal): esa
    // ventana murió con la desconexión, y dejarla "receiving" para siempre le mentiría al panel.
    // No inventa consentimiento ni toca una generación ya terminal — solo la marca con el motivo.
    // Después del cierre, únicamente un nuevo Embedded Signup (claim de code nuevo) abre la
    // siguiente. `ACCOUNT_RECONNECTED` no pasa por acá: reconectar no es offboardear.
    if (esDesconexion) {
      await cerrarGeneracionPorOffboarding(tenantId, pnid, nowMs);
    }

    const accion: AccountUpdateAccion = esDesconexion ? 'degradado' : 'reconectado_sin_permiso';
    await recordAudit({
      tenantId,
      // Se reusa la acción existente a propósito: el hecho es el mismo (ese número dejó de poder
      // automatizar) y la metadata dice que el origen fue Meta y no un administrador.
      action: 'meta.number_deactivated',
      actorUid: null,
      targetType: 'meta',
      targetId: pnid,
      summary: esDesconexion
        ? 'Meta desconectó el número de coexistencia: automatización apagada'
        : 'Meta reconectó el número: vuelve sin permiso de automatización (ADR-0017 §6)',
      metadata: { source: 'account_update', event: update.event, accion },
    });
    logger.info('accountUpdate aplicado', { tenantId, event: update.event, accion });
    return { aplicado: true, accion, tenantId };
  } catch (e) {
    logger.error('accountUpdate: no se pudo aplicar el evento', e, { event: update.event });
    return { aplicado: false, motivo: 'error' };
  }
}
