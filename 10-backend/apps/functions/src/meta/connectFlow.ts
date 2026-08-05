/**
 * meta/connectFlow.ts — Orquestación de la conexión REAL de Meta por tenant (Fase 4B)
 * ==================================================================================
 * exchange(code) → debug_token (valida + scopes + WABA + expiración) → guarda token en
 * SecretStore (naming seguro) → escribe MetaConnection → discovery de assets + índice →
 * subscribe_apps → preflight. Falla seguro: ante token inválido / scopes faltantes / sin
 * WABA / sin phone_number, escribe el estado correspondiente y NO guarda token. El token
 * y el code NUNCA se loguean. Las llamadas a Graph pasan por MetaGraphClient (inyectable).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaConnection, MetaConnectionStatus, MetaConnectionSource } from '@vpw/shared';
import { maskPhone } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { getSecretStore } from '../lib/secretStore.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { metaTokenSecretName } from './secretName.js';
import { META_REQUIRED_SCOPES } from './scopes.js';
import { buildMetaAssets, writeDiscoveredAssets } from './discovery.js';
import { PnidOcupadoError } from './pnidOwnership.js';
import { verifyWhatsappChannel } from './preflight.js';
import { resolveEntitlements } from '../entitlements/entitlements.js';
import type { MetaGraphClient, MetaPhoneNumber } from './graphClient.js';

// ---------------- Helpers PUROS (testeables) ----------------

export function missingScopes(scopes: string[], required: readonly string[]): string[] {
  return required.filter((s) => !scopes.includes(s));
}

/**
 * Elige el phone_number_id: el PEDIDO, o el primero cuando no se pidió ninguno.
 *
 * Antes, si el pedido no estaba entre los del WABA, caía en silencio al primero: el usuario elegía
 * un número y el sistema conectaba OTRO sin decírselo. Con un solo número por cuenta eso era
 * invisible; con dos —el que vende y el que entra por Coexistence— es la diferencia entre conectar
 * el número nuevo y reescribir el que está atendiendo clientes. Un pedido que no se puede cumplir
 * es un error, no una sugerencia.
 */
export function pickSelectedPhone(phones: MetaPhoneNumber[], requestedId?: string): string | null {
  const pedido = (requestedId ?? '').trim();
  if (pedido) return phones.some((p) => p.id === pedido) ? pedido : null;
  return phones[0]?.id ?? null;
}

/**
 * ¿El WABA que mandó el CLIENTE está respaldado por el token?
 *
 * `input.wabaId` viene del `sessionInfo` del Embedded Signup, o sea del navegador: es input del
 * usuario y se usaba tal cual para listar números y suscribir la app. `dbg.wabaIds` sale de los
 * `granular_scopes` del `debug_token` —lo que Meta dice que ese token realmente alcanza— y ya
 * estaba a mano, usado solo como fallback.
 *
 * Si el token no declara ningún WABA no hay con qué contrastar: ahí se acepta el pedido (que es lo
 * que se venía haciendo) porque rechazarlo cortaría altas legítimas cuyo debug_token no expone
 * `granular_scopes`. Cuando el token SÍ los declara, el pedido tiene que estar entre ellos.
 */
export function wabaAutorizado(requestedWabaId: string, wabaIdsDelToken: string[]): boolean {
  if (wabaIdsDelToken.length === 0) return true;
  return wabaIdsDelToken.includes(requestedWabaId);
}

// ---------------- Orquestación (E/S) ----------------

export interface ConnectInput {
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
  wabaName?: string;
}

export type ConnectFailReason =
  | 'exchange_failed'
  | 'token_invalid'
  | 'scopes_insuficientes'
  | 'no_waba'
  | 'no_phone_number'
  | 'phone_number_mismatch'
  | 'phone_number_collision'
  | 'persistencia_incompleta'
  | 'over_number_limit';

export type ConnectResult =
  | { ok: true; status: 'active'; selectedPhoneNumberId: string; phoneNumber: string | null; assetsCount: number }
  | { ok: false; reason: ConnectFailReason; status: MetaConnectionStatus };

/**
 * UN CONNECT FALLIDO NO PUEDE APAGAR EL NÚMERO QUE ESTÁ VENDIENDO.
 *
 * Esto antes escribía `status` + `tokenSecretRef: ''` sobre `metaConnections/main`. O sea: un
 * reintento fallido del Embedded Signup —alcanza con que el `code` haya vencido, y vence en 30 s—
 * dejaba SIN CREDENCIALES a la conexión que está atendiendo clientes: `resolveTenantWhatsappCreds`
 * exige `status === 'active'` y un `tokenSecretRef` con contenido, así que el número quedaba mudo
 * hasta que alguien reconectara. El intento de conectar de un usuario no puede degradar lo que ya
 * funciona; el precedente correcto ya estaba en este mismo archivo (`over_number_limit` no
 * persiste nada).
 *
 * El error igual se guarda —si no, un fallo no se puede diagnosticar—, pero en campos PROPIOS que
 * nadie usa para decidir si el canal sirve. Tampoco se toca `lastVerifiedAt`: un fallo no es una
 * verificación, y fingirlo haría que el panel muestre «recién validado» sobre una conexión que
 * nadie validó.
 */
async function registrarFalloDeConexion(tenantId: string, motivo: string): Promise<void> {
  await db().doc(paths.metaConnection(tenantId, 'main')).set(
    { lastConnectError: motivo, lastConnectErrorAt: Timestamp.now(), updatedAt: Timestamp.now() },
    { merge: true },
  );
}

/** `tokenSecretRef` de la conexión actual (null si no hay conexión previa). */
async function refDelSecretoPrevio(tenantId: string): Promise<string | null> {
  const previo = (await db().doc(paths.metaConnection(tenantId, 'main')).get()).data() as MetaConnection | undefined;
  return previo?.tokenSecretRef || null;
}

/**
 * Rollback del secreto tras un fallo de persistencia: borra SOLO si es uno recién creado.
 *
 * El naming del secreto es determinístico por tenant, así que un reconecte suele producir la MISMA
 * referencia que ya tenía la conexión sana. Borrarla dejaría sin credencial al número que vende —
 * exactamente el desenlace que este endurecimiento existe para impedir—. Por eso se compara contra
 * la referencia preexistente y solo se limpia lo que este intento creó.
 */
async function revertirSecretoNuevo(
  tenantId: string,
  refNueva: string,
  refPrevia: string | null,
  valorPrevio: string | null,
): Promise<void> {
  if (!refNueva) return;
  if (refNueva === refPrevia) {
    // CRÍTICO del correctivo: misma referencia NO significa mismo valor. El naming es
    // determinístico y `set` sobreescribe el documento, así que a esta altura el token que vendía
    // ya fue PISADO por el del intento fallido — y comparar strings de referencia lo dejaba ahí,
    // con la conexión `active` apuntando a una credencial destruida. La referencia es una
    // indirección: lo que hay que devolver es el VALOR.
    if (valorPrevio !== null) {
      try {
        await getSecretStore().set(metaTokenSecretName(tenantId), valorPrevio);
      } catch {
        logger.error('Meta connect: NO se pudo restaurar el token previo tras el fallo — la conexión principal puede quedar sin credencial válida', undefined, { tenantId });
      }
    }
    return;
  }
  try {
    await getSecretStore().remove(refNueva);
  } catch {
    logger.warn('Meta connect: no se pudo limpiar el secreto del intento fallido', { tenantId });
  }
}

/**
 * Escribe el doc determinista metaConnections/main (merge). Helper COMPARTIDO entre el flujo
 * Embedded Signup (defaults: status 'active', tokenType 'live') y el alta manual (WM-1), que pasa
 * `status`/`source` propios. Nunca escribe el token: solo `tokenSecretRef`.
 */
export async function writeActiveConnection(
  tenantId: string,
  fields: {
    byUid?: string | null;
    tokenSecretRef: string;
    tokenExpiresAtMs: number | null;
    scopes: string[];
    businessId?: string;
    businessName?: string;
    status?: MetaConnectionStatus;
    tokenType?: string;
    source?: MetaConnectionSource;
  },
): Promise<void> {
  const ref = db().doc(paths.metaConnection(tenantId, 'main'));
  const existing = (await ref.get()).data() as MetaConnection | undefined;
  const now = Timestamp.now();
  const conn: Partial<MetaConnection> = {
    id: 'main',
    tenantId,
    metaBusinessId: fields.businessId ?? existing?.metaBusinessId ?? '',
    metaBusinessName: fields.businessName ?? existing?.metaBusinessName ?? '',
    connectedUserId: fields.byUid ?? existing?.connectedUserId ?? '',
    tokenSecretRef: fields.tokenSecretRef,
    tokenType: fields.tokenType ?? 'live',
    tokenExpiresAt: fields.tokenExpiresAtMs ? Timestamp.fromMillis(fields.tokenExpiresAtMs) : null,
    scopes: fields.scopes,
    status: fields.status ?? 'active',
    lastVerifiedAt: now,
    errorMessage: '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(fields.source ? { source: fields.source } : {}),
  };
  await ref.set(conn, { merge: true });
}

/** Conecta Meta REAL para un tenant. Falla seguro (estados claros) y nunca loguea secretos. */
export async function runMetaConnect(tenantId: string, input: ConnectInput, byUid: string | null, graph: MetaGraphClient): Promise<ConnectResult> {
  // 1) Intercambio del code por el token (System User de larga duración en ES).
  let token = '';
  try {
    token = (await graph.exchangeCode(input.code)).accessToken;
  } catch (e) {
    logger.error('Meta connect: el intercambio del code falló', e, { tenantId });
  }
  if (!token) {
    await registrarFalloDeConexion(tenantId, 'no se pudo intercambiar el code');
    return { ok: false, reason: 'exchange_failed', status: 'error' };
  }

  // 2) Validación del token + scopes + WABA + expiración (debug_token con app access token).
  const dbg = await graph.debugToken(token);
  if (!dbg.isValid) {
    await registrarFalloDeConexion(tenantId, 'token inválido');
    return { ok: false, reason: 'token_invalid', status: 'expired' };
  }
  const missing = missingScopes(dbg.scopes, META_REQUIRED_SCOPES);
  if (missing.length) {
    await registrarFalloDeConexion(tenantId, `faltan permisos: ${missing.join(', ')}`);
    return { ok: false, reason: 'scopes_insuficientes', status: 'permission_missing' };
  }

  // 3) WABA: el del input (sessionInfo del ES, o sea del navegador) contrastado contra los
  // granular_scopes del token; si el input no trae ninguno, el del token — PERO solo cuando el
  // token autoriza EXACTAMENTE uno. Con varios, «el primero de la lista» puede ser el WABA de
  // OTRO cliente del Tech Provider, y conectar `main` contra esa cuenta redirige el negocio
  // entero: la elección tiene que ser explícita (mismo criterio que `elegirWabaDeCoexistencia`).
  const wabaId = input.wabaId || (dbg.wabaIds.length === 1 ? dbg.wabaIds[0] : undefined);
  if (!wabaId) {
    await registrarFalloDeConexion(
      tenantId,
      dbg.wabaIds.length > 1 ? 'varias cuentas de WhatsApp Business autorizadas: falta la elección explícita' : 'sin WhatsApp Business Account',
    );
    return { ok: false, reason: 'no_waba', status: 'error' };
  }
  if (!wabaAutorizado(wabaId, dbg.wabaIds)) {
    logger.warn('Meta connect: el WABA pedido no está entre los que autoriza el token', { tenantId });
    await registrarFalloDeConexion(tenantId, 'la cuenta de WhatsApp Business pedida no está autorizada por el token');
    return { ok: false, reason: 'no_waba', status: 'error' };
  }

  // 4) Phone numbers del WABA → elegir el seleccionado.
  const phones = await graph.listWabaPhoneNumbers(wabaId, token);
  const selectedPhoneNumberId = pickSelectedPhone(phones, input.phoneNumberId);
  if (!selectedPhoneNumberId) {
    // Se distingue «la cuenta no tiene números» de «el número que pediste no está en esta cuenta»:
    // el segundo caso antes conectaba otro número en silencio, y el usuario no tenía cómo enterarse.
    const huboPedido = (input.phoneNumberId ?? '').trim() !== '';
    const reason: ConnectFailReason = huboPedido ? 'phone_number_mismatch' : 'no_phone_number';
    await registrarFalloDeConexion(tenantId, huboPedido ? 'el número pedido no pertenece a esa cuenta' : 'sin phone_number_id');
    return { ok: false, reason, status: 'error' };
  }

  // 4b) PLAN-LIMITS-3A: conteo real — el plan debe permitir AL MENOS tantos números como tiene el WABA.
  // Idempotente: reconectar el MISMO WABA repite el mismo conteo (mismo resultado del gate). Si se excede,
  // NO persistimos nada (token/conexión/assets) y NO tocamos la conexión existente → el callable lanza
  // failed-precondition. Sin override de admin (no existe ese patrón; el límite es del tenant resuelto).
  const maxNumbers = (await resolveEntitlements(tenantId)).limits.maxWhatsappNumbers;
  if (phones.length > maxNumbers) {
    logger.warn('Meta connect: bloqueado por límite de números del plan', { tenantId, phones: phones.length, limit: maxNumbers });
    return { ok: false, reason: 'over_number_limit', status: 'not_connected' };
  }

  // 5) Token por REFERENCIA (SecretStore, naming seguro). Nunca en claro en Firestore.
  // El VALOR previo se lee ANTES del set: con naming determinístico, el set pisa el documento, y
  // si algo falla después la única forma de devolverle la credencial al número que vende es tener
  // el valor en la mano (la referencia sola no alcanza — es la misma string).
  const refPrevia = await refDelSecretoPrevio(tenantId);
  const valorPrevio = refPrevia ? await getSecretStore().get(refPrevia).catch(() => null) : null;
  const tokenSecretRef = await getSecretStore().set(metaTokenSecretName(tenantId), token);

  /**
   * 6 y 7) EL ORDEN IMPORTA, y es al revés de como estaba.
   *
   * Antes se marcaba la conexión `active` y RECIÉN DESPUÉS se escribían los assets y el índice, sin
   * transacción de por medio: si el discovery fallaba quedaba una conexión que se declaraba activa
   * sin ruteo detrás, y nada distinguía eso de una conexión sana. Ahora el discovery —que es
   * atómico y donde vive el guard de propiedad del PNID— va primero, y la conexión se marca activa
   * solo cuando ya hay a dónde rutear. Un fallo en el medio deja la conexión PREVIA tal como
   * estaba, que es lo único aceptable mientras un número esté vendiendo.
   */
  const assets = buildMetaAssets({ businessId: input.businessId, businessName: input.businessName, wabaId, wabaName: input.wabaName, phones, selectedPhoneNumberId });
  try {
    await writeDiscoveredAssets(tenantId, 'main', assets);
    await writeActiveConnection(tenantId, { byUid, tokenSecretRef, tokenExpiresAtMs: dbg.expiresAtMs, scopes: dbg.scopes, businessId: input.businessId, businessName: input.businessName });
  } catch (e) {
    await revertirSecretoNuevo(tenantId, tokenSecretRef, refPrevia, valorPrevio);
    if (e instanceof PnidOcupadoError) {
      logger.warn('Meta connect: el número ya está conectado en otra empresa', { tenantId, conflictTenantId: e.conflictTenantId });
      await registrarFalloDeConexion(tenantId, 'el número de WhatsApp ya está conectado en otra empresa');
      return { ok: false, reason: 'phone_number_collision', status: 'error' };
    }
    logger.error('Meta connect: no se pudo persistir la conexión', e, { tenantId });
    await registrarFalloDeConexion(tenantId, 'no se pudo guardar la conexión');
    return { ok: false, reason: 'persistencia_incompleta', status: 'error' };
  }

  // 8) Suscribir la app a la WABA para recibir webhooks (best-effort).
  try {
    await graph.subscribeApp(wabaId, token);
  } catch (e) {
    logger.warn('Meta connect: subscribeApp falló (se continúa)', { tenantId });
  }

  // 9) Preflight: ajusta el estado final (active/expired/permission_missing/error).
  try {
    await verifyWhatsappChannel(tenantId, graph);
  } catch (e) {
    logger.warn('Meta connect: preflight falló (se continúa)', { tenantId });
  }

  const phone = phones.find((p) => p.id === selectedPhoneNumberId);
  logger.info('Meta conectado (real)', { tenantId, status: 'active', assets: assets.length });
  // El Embedded Signup era el ÚNICO camino de alta sin auditoría: el alta manual, el número
  // adicional y hasta la conexión demo dejaban rastro, y el camino REAL —por donde va a entrar el
  // número que atiende clientes— no. Metadata saneada: el PNID va enmascarado y el token no aparece.
  await recordAudit({
    tenantId,
    action: 'meta.connected',
    actorUid: byUid,
    targetType: 'meta',
    summary: 'Conexión Meta creada (Embedded Signup)',
    metadata: { source: 'embedded_signup', phoneNumberId: maskPhone(selectedPhoneNumberId), assets: assets.length },
  });
  return { ok: true, status: 'active', selectedPhoneNumberId, phoneNumber: phone?.displayPhoneNumber ?? null, assetsCount: assets.length };
}
