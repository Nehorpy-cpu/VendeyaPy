/**
 * meta/multiNumber.ts — Múltiples números de WhatsApp por empresa (MULTI-NUMBER-1)
 * =================================================================================
 * Modelo: una CONEXIÓN por número. El principal conserva `metaConnections/main` +
 * asset `selected: true` (compat total con el flujo actual). Los adicionales viven en
 * `metaConnections/wa_{phoneNumberId}` con su PROPIO token cifrado
 * (`meta-token-{tenant}-{pnid}`), su asset (`selected: false`) y su entrada de índice
 * `metaExternalIndex/whatsapp_{pnid}` con `connectionId` → el inbound resuelve tenant
 * Y número receptor, y la respuesta sale por el MISMO número (whatsappClient).
 *
 * Reglas:
 *  - Agregar: gate del plan (maxWhatsappNumbers, contando activos), colisión cross-tenant,
 *    re-alta idempotente del mismo número en el mismo tenant. NUNCA pisa al principal.
 *  - Desactivar: SOLO números adicionales (el principal se gestiona con reemplazo WM-1 /
 *    metaDisconnect). Borra el índice (deja de rutear), marca asset/conexión inactivos y
 *    elimina el secreto del token. El HISTORIAL (conversaciones/mensajes) queda intacto.
 *  - El token jamás se escribe en Firestore ni en logs: solo tokenSecretRef.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaAsset, MetaConnection, MetaConnectionStatus, MetaConnectionSource } from '@vpw/shared';
import { whatsappSessionKey, AUTOMATION_MODE_FAIL_CLOSED, CONEXION_HEREDADA } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { metaNumberTokenSecretName } from './secretName.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import type { MetaGraphClient } from './graphClient.js';
import type { ManualWhatsappInput } from './manualConnect.js';
import { assertPnidLibre, duenoActualDePnid, PnidOcupadoError, whatsappIndexId } from './pnidOwnership.js';

/** Id determinístico de la conexión de un número ADICIONAL. */
export function waConnectionId(phoneNumberId: string): string {
  return `wa_${phoneNumberId}`;
}

export interface AddNumberDeps {
  collisionTenant: (phoneNumberId: string) => Promise<string | null>;
  getAsset: (tenantId: string, phoneNumberId: string) => Promise<MetaAsset | null>;
  countActiveNumbers: (tenantId: string) => Promise<number>;
  assertQuota: (tenantId: string, needed: number, actorUid: string | null) => Promise<void>;
  storeToken: (name: string, token: string) => Promise<string>;
  /**
   * Rollback del secreto cuando la escritura posterior falla. Opcional para no romper a quien ya
   * construye estas deps: sin él se usa el SecretStore real, que es lo correcto en producción.
   */
  removeToken?: (ref: string) => Promise<void>;
}

export const defaultAddDeps: Omit<AddNumberDeps, 'assertQuota'> = {
  // Un solo lector de propiedad para los tres caminos: dos copias de la misma regla terminan
  // divergiendo, y la laxa es la que deja pasar.
  collisionTenant: duenoActualDePnid,
  getAsset: async (tenantId, phoneNumberId) =>
    ((await db().doc(paths.metaAsset(tenantId, phoneNumberId)).get()).data() as MetaAsset | undefined) ?? null,
  countActiveNumbers: async (tenantId) => {
    const snap = await db().collection(paths.metaAssets(tenantId)).where('assetType', '==', 'whatsapp_phone_number').get();
    return snap.docs.filter((d) => (d.data() as MetaAsset).status === 'active').length;
  },
  storeToken: (name, token) => getSecretStore().set(name, token),
};

export type AddNumberResult =
  | { ok: true; status: string; phoneNumberId: string; phoneNumber: string | null; connectionId: string }
  | { ok: false; reason: 'phone_number_collision'; conflictTenantId: string }
  | { ok: false; reason: 'already_active' }
  /** El PNID pedido es el del número PRINCIPAL de este tenant. Ver `esNumeroPrincipal`. */
  | { ok: false; reason: 'is_main_number' };

/** Opciones ADITIVAS del alta. Sin ellas el comportamiento es exactamente el de siempre. */
export interface AddNumberOptions {
  /**
   * Origen de la conexión que se escribe. Por defecto `manual_admin`, que es lo que este camino
   * significaba cuando el único llamador era el alta manual. Coexistence entra por Embedded Signup
   * y necesita decirlo: el origen es lo que después explica, mirando el documento, por qué existe
   * esa conexión y quién puede tocarla.
   */
  source?: MetaConnectionSource;
}

/**
 * ¿El PNID pedido es el del número PRINCIPAL del tenant?
 *
 * El asset se direcciona POR PNID, así que dar de alta el principal como "adicional" reescribe EL
 * MISMO DOCUMENTO: `selected: true` se pierde (y `resolveTenantWhatsappCreds` lo exige para
 * resolver el canal por defecto) y `connectionId: 'main'` pasa a `wa_{pnid}` (el ruteo apunta a
 * otra conexión, otro token, y `derivarSessionKey` deja de reconocerlo como canal heredado: su
 * conversación viva se muda de documento). El guard de `already_active` no alcanzaba: un preflight
 * fallido o un token vencido dejan el asset del principal fuera de `active`.
 *
 * PURA y con las DOS fuentes a propósito. El asset es la autoridad, pero el índice es lo que
 * realmente rutea los inbounds: si el asset quedó a medio escribir, el índice sigue siendo el que
 * manda. Alcanza con que UNA declare `main` — el desempate acá es el más conservador.
 */
/** El PNID pedido es el del número principal. Aborta la transacción sin dejar nada escrito. */
export class NumeroPrincipalError extends Error {
  constructor(readonly pnid: string) {
    super('Ese número es el principal de la empresa: no se da de alta como adicional.');
    this.name = 'NumeroPrincipalError';
  }
}

export function esNumeroPrincipal(
  asset: { connectionId?: unknown; selected?: unknown } | null | undefined,
  indice: { connectionId?: unknown } | null | undefined,
): boolean {
  return asset?.connectionId === CONEXION_HEREDADA || asset?.selected === true || indice?.connectionId === CONEXION_HEREDADA;
}

/**
 * Agrega un número ADICIONAL: gate de plan → colisión → token cifrado propio → conexión
 * wa_{pnid} + asset (selected:false) + índice → subscribeApp (best-effort) → verificación
 * real (debug_token + getPhoneNumber) que decide el estado final.
 */
export async function runAddWhatsappNumber(
  tenantId: string,
  input: ManualWhatsappInput,
  adminUid: string,
  graph: MetaGraphClient,
  deps: AddNumberDeps,
  options: AddNumberOptions = {},
): Promise<AddNumberResult> {
  const pnid = input.phoneNumberId;

  // 1) Colisión: otro tenant ya rutea este número → jamás secuestrar webhooks.
  const owner = await deps.collisionTenant(pnid);
  if (owner && owner !== tenantId) return { ok: false, reason: 'phone_number_collision', conflictTenantId: owner };

  const existing = await deps.getAsset(tenantId, pnid);

  // 2) EL PRINCIPAL NUNCA SE DA DE ALTA POR ACÁ, y se chequea ANTES que `already_active`: los dos
  // son ciertos a la vez sobre un principal sano, y «ya está activo» es la respuesta menos
  // informativa de las dos — un llamador que trate `already_active` como «ya estaba, todo bien»
  // (que es lo correcto para un número adicional) daría por conectado el número que vende.
  //
  // Deja de ser hipotético con Coexistence: el WABA que entra por el onboarding del número real
  // puede LISTAR el número que ya vende, y ahí el alta y el desastre son la misma llamada. Este
  // chequeo temprano usa el asset que ya se leyó (cero lecturas extra) y rechaza sin gastar un
  // token; el autoritativo, con las dos fuentes, vive dentro de la transacción.
  if (esNumeroPrincipal(existing, null)) {
    logger.warn('multiNumber: se intentó dar de alta el número PRINCIPAL como adicional', { tenantId });
    return { ok: false, reason: 'is_main_number' };
  }

  // 2b) Mismo tenant: activo → error claro; inactivo/inexistente → alta (re-alta reactiva limpio).
  if (existing && existing.status === 'active') return { ok: false, reason: 'already_active' };

  // 3) Gate del plan: activos actuales + este.
  const actives = await deps.countActiveNumbers(tenantId);
  await deps.assertQuota(tenantId, actives + 1, adminUid);

  // 4) Token cifrado POR NÚMERO. Nunca en Firestore/logs.
  const connectionId = waConnectionId(pnid);
  // La referencia PREEXISTENTE, para no borrar en el rollback un secreto que ya estaba en uso: el
  // naming es determinístico, así que una re-alta produce la misma referencia.
  const refPrevia = ((await db().doc(paths.metaConnection(tenantId, connectionId)).get()).data() as MetaConnection | undefined)?.tokenSecretRef || null;
  const tokenSecretRef = await deps.storeToken(metaNumberTokenSecretName(tenantId, pnid), input.accessToken);

  // 5) Conexión + asset + índice.
  //
  // TRANSACCIÓN, NO BATCH: el chequeo de colisión del paso 1 corre varios pasos antes del commit, y
  // en esa ventana otro tenant puede reclamar el mismo PNID y quedar pisado (sus inbounds pasarían
  // a resolverse a ESTE tenant). Un batch no puede leer, así que el guard tiene que vivir dentro de
  // una transacción para que verificar y reclamar sean el mismo acto. El chequeo temprano se
  // conserva: sirve para rechazar sin gastar un token, pero no es el que autoriza.
  const now = Timestamp.now();
  try {
    await db().runTransaction(async (tx) => {
      await assertPnidLibre(tx, tenantId, pnid);
      // Guard AUTORITATIVO del principal, con las dos fuentes y dentro de la misma transacción que
      // escribe. Va DESPUÉS de `assertPnidLibre` a propósito: una entrada de índice de OTRO tenant
      // ya se rechazó ahí como colisión, así que lo que se lee acá es siempre propio. Firestore
      // exige todas las lecturas antes de la primera escritura: por eso está arriba del `tx.set`.
      const assetTx = (await tx.get(db().doc(paths.metaAsset(tenantId, pnid)))).data() as Record<string, unknown> | undefined;
      const idxTx = (await tx.get(db().doc(paths.metaExternalIndexEntry(whatsappIndexId(pnid))))).data() as Record<string, unknown> | undefined;
      if (esNumeroPrincipal(assetTx, idxTx)) throw new NumeroPrincipalError(pnid);
      tx.set(db().doc(paths.metaConnection(tenantId, connectionId)), {
        id: connectionId,
        tenantId,
        metaBusinessId: input.businessId ?? '',
        metaBusinessName: input.businessName ?? '',
        connectedUserId: adminUid,
        tokenSecretRef,
        tokenType: 'live',
        tokenExpiresAt: input.tokenExpiresAtMs ? Timestamp.fromMillis(input.tokenExpiresAtMs) : null,
        scopes: [],
        status: 'pending_review', // el estado FINAL lo decide la verificación de abajo
        source: options.source ?? 'manual_admin',
        // metadata segura del número (MULTI-NUMBER-1); sin tokens.
        wabaId: input.wabaId,
        displayPhoneNumber: input.displayPhoneNumber,
        lastVerifiedAt: now,
        errorMessage: '',
        createdAt: (existing ? undefined : now) ?? now,
        updatedAt: now,
      } as Partial<MetaConnection> & Record<string, unknown>);
      tx.set(db().doc(paths.metaAsset(tenantId, pnid)), {
        id: pnid, tenantId, connectionId, assetType: 'whatsapp_phone_number', externalId: pnid,
        name: input.displayPhoneNumber, status: 'active', selected: false, createdAt: now, updatedAt: now,
        // ADR-0017 §1: el alta NO escribe `automationMode`. El campo AUSENTE ya significa `inactive`
        // por fail-closed, así que el número nace sin permiso para contestarle a nadie y pasar a
        // `shadow` —y después a `live`— es una decisión humana aparte. Escribir acá cualquier valor
        // reviviría el defecto que este ADR mata: `status:'active'` autorizando automatización.
        //
        // ADR-0017 §2: sí estrena su PROPIO canal de conversación. Si naciera sobre `active`, el
        // primer mensaje que reciba se mezclaría con la conversación abierta del número que ya vende:
        // mismo carrito, mismo `humanTakeover`, mismo pedido pendiente.
        sessionKey: whatsappSessionKey(pnid),
      });
      tx.set(db().doc(paths.metaExternalIndexEntry(whatsappIndexId(pnid))), {
        id: whatsappIndexId(pnid), tenantId, connectionId, assetType: 'whatsapp_phone_number',
        platform: 'whatsapp', externalId: pnid, status: 'active', updatedAt: now,
      });
    });
  } catch (e) {
    // El token se guardó ANTES de la escritura: si la escritura no ocurre, ese secreto queda
    // huérfano. Se limpia SOLO si lo creó este intento — borrar la referencia preexistente dejaría
    // sin credencial a un número que ya estaba conectado.
    if (tokenSecretRef && tokenSecretRef !== refPrevia) {
      const borrar = deps.removeToken ?? ((ref: string) => getSecretStore().remove(ref));
      await borrar(tokenSecretRef).catch(() => logger.warn('multiNumber: no se pudo limpiar el secreto del alta fallida', { tenantId, connectionId }));
    }
    if (e instanceof PnidOcupadoError) {
      logger.warn('multiNumber: colisión de PNID detectada al escribir', { tenantId, connectionId });
      return { ok: false, reason: 'phone_number_collision', conflictTenantId: e.conflictTenantId };
    }
    if (e instanceof NumeroPrincipalError) {
      logger.warn('multiNumber: el PNID pedido es el del número principal (rechazado al escribir)', { tenantId });
      return { ok: false, reason: 'is_main_number' };
    }
    throw e;
  }

  // 6) Suscribir la app a la WABA (best-effort; el inbound real lo requiere en Meta).
  try {
    await graph.subscribeApp(input.wabaId, input.accessToken);
  } catch {
    logger.warn('multiNumber: subscribeApp falló (continuar; suscribir en Meta manualmente)', { tenantId, connectionId });
  }

  // 7) Verificación real por NÚMERO: token válido + el pnid resuelve.
  let status = 'pending_review';
  let phoneNumber: string | null = input.displayPhoneNumber;
  try {
    const dbg = await graph.debugToken(input.accessToken);
    const phone = dbg.isValid ? await graph.getPhoneNumber(pnid, input.accessToken) : null;
    status = dbg.isValid && phone ? 'active' : 'error';
    if (phone?.displayPhoneNumber) phoneNumber = phone.displayPhoneNumber;
  } catch {
    logger.warn('multiNumber: verificación falló (queda pending_review)', { tenantId, connectionId });
  }
  await db().doc(paths.metaConnection(tenantId, connectionId)).set({ status, lastVerifiedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });

  logger.info('Número adicional de WhatsApp agregado', { tenantId, connectionId, status });
  return { ok: true, status, phoneNumberId: pnid, phoneNumber, connectionId };
}

export type DeactivateResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'is_default' | 'is_main' };

/**
 * Desactiva un número ADICIONAL: fuera del índice (deja de rutear), asset/conexión inactivos,
 * secreto del token eliminado. Historial de conversaciones/mensajes: INTACTO.
 */
export async function deactivateWhatsappNumber(tenantId: string, phoneNumberId: string): Promise<DeactivateResult> {
  const assetRef = db().doc(paths.metaAsset(tenantId, phoneNumberId));
  const asset = (await assetRef.get()).data() as MetaAsset | undefined;
  if (!asset || asset.assetType !== 'whatsapp_phone_number') return { ok: false, reason: 'not_found' };
  if (asset.selected) return { ok: false, reason: 'is_default' };
  const connectionId = (asset as MetaAsset & { connectionId?: string }).connectionId ?? 'main';
  if (connectionId === 'main') return { ok: false, reason: 'is_main' };

  const connRef = db().doc(paths.metaConnection(tenantId, connectionId));
  const conn = (await connRef.get()).data() as MetaConnection | undefined;

  const now = Timestamp.now();
  const batch = db().batch();
  // ADR-0017 §1: apagar un número es REVOCARLE el permiso, y eso se escribe.
  // Si solo quedara implícito en `status`, una reconexión posterior (que PRESERVA el
  // `automationMode` para no dejar mudo al número que vende) lo devolvería a `live` sin que
  // ningún humano lo decidiera. La `sessionKey` NO se toca: el merge la conserva y perderla
  // fusionaría su conversación con la del canal heredado.
  batch.set(assetRef, { status: 'inactive', selected: false, automationMode: AUTOMATION_MODE_FAIL_CLOSED, updatedAt: now }, { merge: true });
  batch.delete(db().doc(paths.metaExternalIndexEntry(whatsappIndexId(phoneNumberId))));
  // El estado de la CONEXIÓN pertenece al enum `MetaConnectionStatus`: acá se escribía
  // `'disconnected'`, que no es miembro (sí lo es del estado del ASSET, que es otro eje y otro
  // vocabulario — ver `ASSET_STATUS_DESCONECTADO`). El panel mapea estados conocidos, así que un
  // valor fuera del enum se renderiza como un estado inexistente. `not_connected` es el mismo que
  // deja `disconnectMeta` y significa exactamente esto: esta conexión ya no conecta con nada.
  const statusDesconectado: MetaConnectionStatus = 'not_connected';
  batch.set(connRef, { status: statusDesconectado, updatedAt: now }, { merge: true });
  await batch.commit();

  // Higiene: el token deja de existir (revocarlo en Meta sigue siendo recomendable).
  if (conn?.tokenSecretRef) {
    try {
      await getSecretStore().remove(conn.tokenSecretRef);
    } catch {
      logger.warn('multiNumber: no se pudo borrar el secreto del token (conexión igual desactivada)', { tenantId, connectionId });
    }
  }
  logger.info('Número adicional de WhatsApp desactivado', { tenantId, connectionId, phoneNumberId });
  return { ok: true };
}

/**
 * ADR-0020 (G3) — Baja OWNER-FACING de una conexión `wa_{pnid}` (`metaDisconnect` con
 * `connectionId`). REUTILIZA `deactivateWhatsappNumber` tal cual: asset `inactive` con el permiso
 * revocado, SU entrada de índice borrada (deja de rutear), SU conexión a `not_connected` y SU
 * secreto retirado — el mismo orden compensable de siempre (el secreto al final; si falla, la
 * conexión ya no rutea y el retiro se reintenta). JAMÁS toca `main` (guards `is_default`/`is_main`)
 * ni números de otro tenant (el asset se lee tenant-scoped). NADA se borra dentro de Meta.
 *
 * La auditoría va acá y no en el callable para que cualquier superficie que dé de baja por
 * conexión deje el mismo rastro: `meta.number_deactivated` con el actor.
 */
export async function disconnectWhatsappNumberConnection(
  tenantId: string,
  connectionId: string,
  actorUid: string | null,
): Promise<DeactivateResult> {
  const phoneNumberId = connectionId.startsWith('wa_') ? connectionId.slice(3) : '';
  if (!phoneNumberId) return { ok: false, reason: 'not_found' };
  const result = await deactivateWhatsappNumber(tenantId, phoneNumberId);
  if (!result.ok) return result;
  await recordAudit({
    tenantId,
    action: 'meta.number_deactivated',
    actorUid,
    targetType: 'meta',
    targetId: phoneNumberId,
    summary: 'Número de WhatsApp desconectado por su empresa (historial intacto; nada se borra en Meta)',
    metadata: { phoneNumberId, connectionId },
  });
  return result;
}
