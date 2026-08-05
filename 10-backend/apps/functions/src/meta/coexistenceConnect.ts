/**
 * meta/coexistenceConnect.ts — Completar Coexistence SIN rozar `metaConnections/main` (ADR-0017)
 * ===============================================================================================
 * ETAPA C del programa. El camino de backend que cierra el Embedded Signup de Coexistence: el
 * `code` entra, y del otro lado queda una conexión propia `wa_{pnid}`, con su token, su asset y su
 * entrada de índice — y el número que hoy está vendiendo, intacto.
 *
 * TRES COSAS DEL CONTRATO OFICIAL (verificado 2026-08-04 · ADR-0017 §5, ARCHITECTURE §12.1) que
 * gobiernan este archivo y que NO son detalles de implementación:
 *
 *  1. **El PNID se resuelve SERVER-SIDE.** El evento de cierre
 *     `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` trae, en su página específica, SOLO `waba_id` (la
 *     página genérica lo lista con `phone_number_id`: Meta se contradice). De ahí que este flujo
 *     pida el WABA y resuelva el número con `GET /<WABA_ID>/phone_numbers`. Confiar en un
 *     `phone_number_id` que viene por `postMessage` sería dejar que el navegador elija sobre qué
 *     documento se escribe — y el documento del asset se direcciona por PNID.
 *
 *  2. **NO se llama al `/register` estándar.** La documentación de Coexistence no lo pide en
 *     ningún paso: el número YA está registrado en la app de WhatsApp Business del vendedor y el
 *     onboarding es justamente lo que lo pone en coexistencia. `/register` es el paso del alta
 *     estándar (un número nuevo que hay que dar de alta en Cloud API con su PIN), y ejecutarlo
 *     contra un número que ya opera es, en el mejor caso, un error de Graph; en el peor, una
 *     mutación sobre el número por el que la empresa vende. Este archivo no tiene esa llamada, y
 *     este comentario existe para que agregarla sea una decisión y no un descuido.
 *
 *  3. **Un número nuevo nace MUDO.** `automationMode` ausente ⇒ `inactive` por fail-closed
 *     (ADR-0017 §1), `selected: false`, jamás default. Pasar a `shadow` y después a `live` es una
 *     decisión humana aparte. Este flujo no la toma ni la insinúa.
 *
 * LA LÓGICA DE ESCRITURA NO SE DUPLICA: la transacción que reclama el PNID, escribe la conexión,
 * el asset y el índice, y hace rollback del secreto ante un fallo parcial, ya vive en
 * `multiNumber.ts` y es la que se usa. Acá vive lo que multiNumber no puede saber: cómo se llega
 * al token y al PNID cuando lo único que hay es un `code` y un WABA.
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { MetaConnection, MetaConnectionStatus } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { missingScopes, wabaAutorizado } from './connectFlow.js';
import { META_REQUIRED_SCOPES } from './scopes.js';
import { metaNumberTokenSecretName } from './secretName.js';
import { runAddWhatsappNumber, waConnectionId, type AddNumberDeps } from './multiNumber.js';
import type { MetaGraphClient, MetaPhoneNumber } from './graphClient.js';

export interface CoexistenceConnectInput {
  /** `code` del Embedded Signup. Nunca se loguea. */
  code: string;
  /** `waba_id` del `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`. Es el ÚNICO id documentado ahí. */
  wabaId?: string;
  /**
   * Desempate OPCIONAL cuando el WABA lista más de un número. NO es la fuente del PNID: si viene,
   * tiene que estar entre los que devuelve Graph, o el flujo falla. Un pedido que no se puede
   * cumplir es un error, no una sugerencia (mismo criterio que `pickSelectedPhone`).
   */
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
}

export type CoexistenceConnectFailReason =
  | 'exchange_failed'
  | 'token_invalid'
  | 'scopes_insuficientes'
  | 'no_waba'
  | 'no_phone_number'
  | 'phone_number_mismatch'
  | 'phone_number_ambiguo'
  | 'phone_number_collision'
  | 'is_main_number'
  | 'persistencia_incompleta';

export type CoexistenceConnectResult =
  | {
      ok: true;
      connectionId: string;
      phoneNumberId: string;
      phoneNumber: string | null;
      status: string;
      /** true ⇒ la conexión ya existía y no se escribió nada nuevo (replay del callback). */
      replay: boolean;
    }
  | { ok: false; reason: CoexistenceConnectFailReason; conflictTenantId?: string };

/**
 * Elige el número del WABA. Deliberadamente ESTRICTA en los dos extremos:
 *
 *  - sin pedido y con UN solo número ⇒ ese (el caso real de Coexistence: se onboardea un número).
 *  - sin pedido y con VARIOS ⇒ `null` con motivo `ambiguo`. Adivinar «el primero» es exactamente
 *    cómo se termina conectando el número que ya vende: un WABA puede listar los dos.
 *  - con pedido ⇒ tiene que estar en la lista de Graph, si no `mismatch`.
 */
export function elegirNumeroDeCoexistencia(
  phones: readonly MetaPhoneNumber[],
  pedido?: string,
): { ok: true; phoneNumberId: string } | { ok: false; reason: 'no_phone_number' | 'phone_number_mismatch' | 'phone_number_ambiguo' } {
  const limpio = (pedido ?? '').trim();
  if (limpio) {
    return phones.some((p) => p.id === limpio)
      ? { ok: true, phoneNumberId: limpio }
      : { ok: false, reason: 'phone_number_mismatch' };
  }
  if (phones.length === 0) return { ok: false, reason: 'no_phone_number' };
  if (phones.length > 1) return { ok: false, reason: 'phone_number_ambiguo' };
  return { ok: true, phoneNumberId: phones[0]!.id };
}

/**
 * Ejecuta la conexión de Coexistence. `deps` son las MISMAS de `runAddWhatsappNumber` (el
 * llamador arma el gate del plan igual que el alta manual): acá no se reimplementa ninguna.
 */
export async function runCoexistenceConnect(
  tenantId: string,
  input: CoexistenceConnectInput,
  byUid: string,
  graph: MetaGraphClient,
  deps: AddNumberDeps,
): Promise<CoexistenceConnectResult> {
  // 1) code → token. El error se loguea sin el code ni el token.
  let token = '';
  try {
    token = (await graph.exchangeCode(input.code)).accessToken;
  } catch (e) {
    logger.error('Coexistence: el intercambio del code falló', e, { tenantId });
  }
  if (!token) return { ok: false, reason: 'exchange_failed' };

  // 2) El token, validado por Meta. Sin esto no se sabe ni qué WABA alcanza.
  const dbg = await graph.debugToken(token);
  if (!dbg.isValid) return { ok: false, reason: 'token_invalid' };
  const faltantes = missingScopes(dbg.scopes, META_REQUIRED_SCOPES);
  if (faltantes.length) {
    logger.warn('Coexistence: faltan permisos en el token', { tenantId, faltantes });
    return { ok: false, reason: 'scopes_insuficientes' };
  }

  // 3) WABA: el que declaró el evento de cierre, contrastado contra los granular_scopes del token.
  // Un WABA que el token no respalda no se toca: sería operar sobre la cuenta de otro negocio.
  const wabaId = (input.wabaId ?? '').trim() || dbg.wabaIds[0] || '';
  if (!wabaId) return { ok: false, reason: 'no_waba' };
  if (!wabaAutorizado(wabaId, dbg.wabaIds)) {
    logger.warn('Coexistence: el WABA pedido no está entre los que autoriza el token', { tenantId });
    return { ok: false, reason: 'no_waba' };
  }

  // 4) EL PNID, RESUELTO SERVER-SIDE (ver el encabezado, punto 1).
  const phones = await graph.listWabaPhoneNumbers(wabaId, token);
  const elegido = elegirNumeroDeCoexistencia(phones, input.phoneNumberId);
  if (!elegido.ok) {
    logger.warn('Coexistence: no se pudo determinar el número a conectar', { tenantId, reason: elegido.reason, cuantos: phones.length });
    return { ok: false, reason: elegido.reason };
  }
  const pnid = elegido.phoneNumberId;
  const phone = phones.find((p) => p.id === pnid) ?? null;

  // 5) Alta como número ADICIONAL. Todo lo delicado —colisión cross-tenant dentro de la
  // transacción, guard del número principal, token cifrado propio, rollback del secreto ante fallo
  // parcial— ya vive ahí y es lo mismo que audita `multiNumber.principal.test.ts`.
  const alta = await runAddWhatsappNumber(
    tenantId,
    {
      wabaId,
      phoneNumberId: pnid,
      displayPhoneNumber: phone?.displayPhoneNumber ?? '',
      businessId: input.businessId,
      businessName: input.businessName,
      accessToken: token,
      // El System User del Embedded Signup no expira; si el debug_token declara vencimiento, se
      // respeta. `resolveTenantWhatsappCredsFor` lo usa para no mandar con un token muerto.
      tokenExpiresAtMs: dbg.expiresAtMs,
    },
    byUid,
    graph,
    deps,
    // El origen queda escrito en la conexión: es lo que después explica por qué existe y por qué
    // no se administra como un alta manual.
    { source: 'embedded_signup' },
  );

  if (alta.ok) {
    logger.info('Coexistence: número conectado (sin permiso de automatización)', { tenantId, connectionId: alta.connectionId, status: alta.status });
    return { ok: true, connectionId: alta.connectionId, phoneNumberId: alta.phoneNumberId, phoneNumber: alta.phoneNumber, status: alta.status, replay: false };
  }

  // 6) REPLAY DEL CALLBACK ⇒ MISMO RESULTADO, PERO CON LA CREDENCIAL FRESCA (correctivo, ALTO 6).
  // `already_active` cubre dos casos que se veían iguales y no lo son: el callback repetido del
  // MISMO signup (donde no hay nada que refrescar) y el RE-ONBOARDING tras un offboarding, donde
  // el signup nuevo acaba de emitir un token NUEVO. Descartarlo dejaba a la conexión con el token
  // del ciclo anterior — y el ciclo de recuperación del ADR §5 («offboardear y rehacer el
  // Embedded Signup») no convergía nunca: la generación nueva corría su ventana de 24 h con una
  // credencial vieja. El secreto del número tiene naming determinístico, así que refrescarlo es
  // un `set` sobre el mismo documento: ni segunda conexión ni segundo secreto — el invariante del
  // replay se conserva.
  if (alta.reason === 'already_active') {
    const connectionId = waConnectionId(pnid);
    try {
      await deps.storeToken(metaNumberTokenSecretName(tenantId, pnid), token);
      await db().doc(paths.metaConnection(tenantId, connectionId)).set(
        { status: 'active', lastVerifiedAt: Timestamp.now(), updatedAt: Timestamp.now() },
        { merge: true },
      );
    } catch (e) {
      // El refresco es best-effort: si falla, la conexión queda como estaba (el replay clásico) y
      // el diagnóstico es visible. No se aborta un onboarding que Meta ya dio por bueno.
      logger.error('Coexistence: no se pudo refrescar la credencial en el re-onboarding', e, { tenantId });
    }
    const conn = (await db().doc(paths.metaConnection(tenantId, connectionId)).get()).data() as MetaConnection | undefined;
    const status: MetaConnectionStatus | string = conn?.status ?? 'active';
    logger.info('Coexistence: conexión ya existente; credencial refrescada con el token del signup nuevo', { tenantId, connectionId });
    return { ok: true, connectionId, phoneNumberId: pnid, phoneNumber: phone?.displayPhoneNumber ?? null, status, replay: true };
  }

  if (alta.reason === 'phone_number_collision') {
    return { ok: false, reason: 'phone_number_collision', conflictTenantId: alta.conflictTenantId };
  }
  // `is_main_number`: el WABA listó el número que YA vende y alguien pidió conectarlo por acá.
  // Se rechaza sin escribir nada — ver `esNumeroPrincipal` en multiNumber.ts.
  return { ok: false, reason: alta.reason };
}
