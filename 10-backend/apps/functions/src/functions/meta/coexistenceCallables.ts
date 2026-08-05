/**
 * functions/meta/coexistenceCallables.ts — La superficie autenticada de Coexistence (ADR-0017)
 * ==============================================================================================
 * Cuatro callables, y cada uno existe por una restricción del contrato oficial verificado el
 * 2026-08-04, no por simetría de API:
 *
 *  · `coexistenceStart` / `coexistenceConnect` — cierran el Embedded Signup del número real. El
 *    `phone_number_id` NO viaja como fuente: el evento `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`
 *    trae sólo `waba_id` y el número se resuelve server-side (ver `coexistenceConnect.ts`).
 *  · `coexistenceDecideHistorySharing` — la decisión HUMANA, explícita y PREVIA sobre el historial.
 *    Sin ella no se dispara nada, y la opción segura por defecto es NO compartir: si el ingestor no
 *    está probado, `skip` es la única que no apuesta la ventana de 24 h sobre un número con
 *    clientes vivos (ADR-0017 §4).
 *  · `coexistenceRequestHistorySync` — EL disparo. Se puede usar UNA sola vez en la vida de ese
 *    número; el coordinador durable lo reclama transaccionalmente y explica cualquier rechazo.
 *  · `coexistenceSyncStatus` — evidencia terminal SANEADA para auditar el resultado. Sin secretos,
 *    sin PII: contadores, estados y marcas de tiempo.
 *
 * AUTORIZACIÓN: la misma de `metaConnect` (PLATFORM_ADMIN con tenant, o TENANT_OWNER de su
 * empresa). Manager/viewer/seller: denegado. Nunca se loguean `code` ni tokens.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import type { MetaConnection } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../../audit/audit.js';
import { resolveMetaConnectAuth } from '../../meta/authz.js';
import { createMetaConnectNonce, consumeMetaConnectNonce, claimMetaConnectCode, claimIdDeCodigo, type MetaConnectMode } from '../../meta/nonce.js';
import { getMetaGraphClient } from '../../meta/graphClient.js';
import { META_APP_SECRET } from '../../meta/metaSecrets.js';
import { assertWhatsappNumbersEntitled } from '../../entitlements/entitlements.js';
import { defaultAddDeps, waConnectionId } from '../../meta/multiNumber.js';
import { runCoexistenceConnect, type CoexistenceConnectFailReason } from '../../meta/coexistenceConnect.js';
import { ejecutarSincronizacionDeHistorial } from '../../meta/smbAppData.js';
import {
  abrirNuevaGeneracion,
  conReintentos,
  leerCoordinador,
  registrarDecisionDeHistorial,
  vencido,
  HISTORY_SHARING_DECISIONS,
  type HistorySharingDecision,
} from '../../meta/historyCoordinator.js';

function authorize(req: CallableRequest<unknown>, requestedTenantId?: string): { tenantId: string; uid: string } {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const result = resolveMetaConnectAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!result.ok) throw new HttpsError(result.code, result.message);
  return { tenantId: result.tenantId, uid: req.auth.uid };
}

const pnidDe = (valor: unknown): string => (typeof valor === 'string' ? valor.trim() : '');

const CONNECT_FAIL_MESSAGE: Record<CoexistenceConnectFailReason, string> = {
  exchange_failed: 'No se pudo validar la autorización de Meta. Reintentá el proceso desde el botón de conectar.',
  token_invalid: 'El token que devolvió Meta no es válido. Reiniciá el proceso.',
  scopes_insuficientes: 'Faltan permisos de WhatsApp. Aceptá todos los permisos durante el onboarding.',
  no_waba: 'La cuenta de WhatsApp Business no está autorizada por esta conexión.',
  waba_ambiguo: 'Tu autorización de Meta alcanza a más de una cuenta de WhatsApp Business. Elegí explícitamente cuál conectar y volvé a intentar.',
  no_phone_number: 'Esa cuenta de WhatsApp Business no tiene ningún número.',
  phone_number_mismatch: 'El número elegido no pertenece a esa cuenta de WhatsApp Business.',
  phone_number_ambiguo: 'Esa cuenta tiene más de un número: elegí explícitamente cuál conectar (no se adivina, para no tocar el número que ya está vendiendo).',
  phone_number_collision: 'Ese número de WhatsApp ya está conectado en otra empresa.',
  is_main_number: 'Ese es el número principal de la empresa: no se conecta por acá. Usá el reemplazo de la conexión principal.',
  persistencia_incompleta: 'No se pudo guardar la conexión. Lo que ya estaba conectado quedó intacto: reintentá.',
};

/**
 * EL MODO CON EL QUE SE EMITE Y SE CONSUME EL NONCE DE ESTA SUPERFICIE. ADR-0017 §5: «un nonce
 * estándar NO puede consumirse como Coexistence ni al revés».
 *
 * `nonce.ts` ya sabía atar el modo, pero estos dos callables lo omitían y por omisión quedaban en
 * `standard` — o sea, exactamente el cruce que el ADR prohíbe, en las dos direcciones: un nonce
 * pedido por el botón ESTÁNDAR cerraba este onboarding, y el nonce que emitía `coexistenceStart`
 * servía para cerrar un `connectMeta` estándar, que escribe sobre `metaConnections/main` — la
 * conexión del número que hoy vende. Son dos consentimientos distintos del dueño sobre dos actos
 * distintos y uno de ellos corre sobre clientes vivos.
 */
const MODO: MetaConnectMode = 'coexistence';

/** Nonce de un solo uso para el Embedded Signup de Coexistence, atado a ESE modo. */
export const coexistenceStart = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const nonce = await createMetaConnectNonce(tenantId, uid, MODO);
  logger.info('Coexistence: nonce emitido', { tenantId, mode: MODO });
  return { ok: true, nonce, mode: MODO };
});

/**
 * Cierra el onboarding. El número queda conectado en su PROPIA conexión `wa_{pnid}` y MUDO:
 * `automationMode` ausente ⇒ `inactive` por fail-closed, `selected: false`. Pasar a `shadow` y
 * después a `live` es una decisión humana aparte, que este callable no toma ni insinúa.
 */
export const coexistenceConnect = onCall<{
  tenantId?: string;
  nonce?: string;
  code?: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
}>({ region: 'us-central1', secrets: [META_APP_SECRET] }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const d = req.data ?? {};
  if (!d.code) throw new HttpsError('invalid-argument', 'Falta el code de Meta.');

  await assertWhatsappNumbersEntitled(tenantId, { actorUid: uid });

  if (!(await consumeMetaConnectNonce(d.nonce ?? '', { tenantId, uid, mode: MODO }))) {
    throw new HttpsError('failed-precondition', 'Sesión de conexión inválida o expirada. Reiniciá el proceso.');
  }
  // El nonce garantiza que ESTA sesión se use una vez; nada impediría pedir otro nonce y reenviar
  // el MISMO code. El reclamo es transaccional, así que también es el single-flight entre
  // invocaciones concurrentes — y es la primera mitad de que un replay del callback no escriba dos
  // veces. La segunda vive en `runCoexistenceConnect` (`replay: true`).
  if (!(await claimMetaConnectCode(d.code, { tenantId, uid, mode: MODO }))) {
    logger.warn('Coexistence: code ya utilizado (replay o doble envío)', { tenantId });
    throw new HttpsError('failed-precondition', 'Esa autorización de Meta ya fue utilizada. Reiniciá el proceso.');
  }

  const graph = await getMetaGraphClient();
  const result = await runCoexistenceConnect(
    tenantId,
    { code: d.code, wabaId: d.wabaId, phoneNumberId: d.phoneNumberId, businessId: d.businessId, businessName: d.businessName },
    uid,
    graph,
    { ...defaultAddDeps, assertQuota: (t, needed, actorUid) => assertWhatsappNumbersEntitled(t, { actorUid, needed }) },
  );
  if (!result.ok) {
    logger.warn('Coexistence: la conexión falló', { tenantId, reason: result.reason });
    throw new HttpsError('failed-precondition', CONNECT_FAIL_MESSAGE[result.reason]);
  }

  if (!result.replay) {
    await recordAudit({
      tenantId,
      action: 'meta.number_added',
      actorUid: uid,
      targetType: 'meta',
      targetId: result.phoneNumberId,
      summary: 'Número real conectado por Coexistence (sin permiso de automatización)',
      // Sin token, sin code. El PNID es un id opaco de Meta, no el teléfono del negocio.
      metadata: { source: 'coexistence', connectionId: result.connectionId, status: result.status, automationMode: 'inactive' },
    });
  }

  /**
   * GENERACIONES DEL HISTORIAL (ADR-0017 §5). Cada onboarding autorizado —y este acaba de
   * demostrarse: el claim del code pasó, que es de un solo uso— abre (o ancla, la primera vez) la
   * generación de sincronización. Se invoca SIEMPRE, incluso con `result.replay`: un re-onboarding
   * tras offboarding encuentra la conexión `wa_{pnid}` existente (replay a nivel conexión) pero su
   * code es NUEVO, y esa es exactamente la señal de que la ventana de 24 h volvió a nacer. El
   * momento del connect ES el onboarding: la ventana corre desde acá.
   *
   * Un fallo acá no tumba el connect (la conexión ya persistió y romperla no la desharía): queda
   * logueado como error y es diagnosticable — `decide`/`request` rechazarían con el estado de la
   * generación anterior, que es visible en el panel.
   */
  try {
    // Capturado en constante: el narrowing del guard `if (!d.code) throw` no entra al closure.
    const claimId = claimIdDeCodigo(d.code);
    const apertura = await conReintentos(() => abrirNuevaGeneracion({
      tenantId,
      phoneNumberId: result.phoneNumberId,
      connectionId: result.connectionId,
      claimId,
      onboardedAtMs: Date.now(),
      nowMs: Date.now(),
    }), 3);
    if (!apertura.ok) {
      // No debería poder pasar (el claim recién se consumió por primera vez); si pasa, es evidencia.
      logger.error('Coexistence: la apertura de generación rechazó un claim recién consumido', undefined, { tenantId, reason: apertura.reason });
    }
  } catch (e) {
    logger.error('Coexistence: no se pudo abrir la generación del historial tras el onboarding', e, { tenantId });
  }
  return {
    ok: true,
    connectionId: result.connectionId,
    phoneNumberId: result.phoneNumberId,
    phoneNumber: result.phoneNumber,
    status: result.status,
    replay: result.replay,
    automationMode: 'inactive',
  };
});

/**
 * Cuándo arrancó la ventana de 24 h. Se DERIVA del `createdAt` de la conexión del número y jamás
 * se toma del cliente: un `onboardedAt` de entrada sería un parámetro para estirar un deadline que
 * lo pone Meta. Se acota a «no en el futuro» por si el documento viniera con basura.
 */
async function onboardingDe(tenantId: string, phoneNumberId: string, nowMs: number): Promise<number> {
  const conn = (await db().doc(paths.metaConnection(tenantId, waConnectionId(phoneNumberId))).get()).data() as MetaConnection | undefined;
  const creado = conn?.createdAt ? conn.createdAt.toMillis() : nowMs;
  return Math.min(creado, nowMs);
}

/**
 * LA DECISIÓN HUMANA sobre el historial. Explícita, previa al disparo y de una sola vez:
 * cambiarla exige offboardear el número y rehacer el Embedded Signup, así que fingir que un botón
 * alcanza sería mentir.
 */
/**
 * ¿Esta conexión nació del Embedded Signup de Coexistence? PURA y exportada para testearla.
 * El historial de Business App es un concepto EXCLUSIVO de Coexistence: un número dado de alta a
 * mano (source manual_admin) no tiene historial que pedir, y dejarlo pasar quemaba el ÚNICO
 * disparo contra un número que jamás lo tuvo (correctivo, MEDIO 12).
 */
export function esConexionDeCoexistence(conn: { source?: unknown } | null | undefined): boolean {
  return conn?.source === 'embedded_signup';
}

export const coexistenceDecideHistorySharing = onCall<{ tenantId?: string; phoneNumberId?: string; decision?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId, uid } = authorize(req, req.data?.tenantId);
    const phoneNumberId = pnidDe(req.data?.phoneNumberId);
    if (!phoneNumberId) throw new HttpsError('invalid-argument', 'Falta phoneNumberId.');
    const decision = req.data?.decision as HistorySharingDecision | undefined;
    if (!decision || !(HISTORY_SHARING_DECISIONS as readonly string[]).includes(decision)) {
      throw new HttpsError('invalid-argument', 'La decisión tiene que ser exactamente `share` o `skip`.');
    }
    const connectionId = waConnectionId(phoneNumberId);
    const connGuard = (await db().doc(paths.metaConnection(tenantId, connectionId)).get()).data() as { source?: unknown } | undefined;
    if (!connGuard || !esConexionDeCoexistence(connGuard)) {
      throw new HttpsError('failed-precondition', 'Ese número no está conectado por Coexistence en esta empresa.');
    }

    const nowMs = Date.now();
    const r = await registrarDecisionDeHistorial({
      tenantId,
      phoneNumberId,
      connectionId,
      decision,
      actorUid: uid,
      onboardedAtMs: await onboardingDe(tenantId, phoneNumberId, nowMs),
      nowMs,
    });
    if (!r.ok) throw new HttpsError('failed-precondition', r.explicacion);

    await recordAudit({
      tenantId, action: 'meta.number_added', actorUid: uid, targetType: 'meta', targetId: phoneNumberId,
      summary: decision === 'share' ? 'Se decidió COMPARTIR el historial del número de Coexistence' : 'Se decidió NO compartir el historial del número de Coexistence',
      metadata: { source: 'coexistence', decision, status: r.status, deadlineAtMs: r.deadlineAtMs },
    });
    return { ok: true, status: r.status, deadlineAtMs: r.deadlineAtMs };
  },
);

/**
 * EL DISPARO. `POST /<PNID>/smb_app_data` con los dos `sync_type`, con el token de ESA conexión.
 * Sin esto no llega un solo webhook de historial; y con esto, no se puede volver a pedir nunca.
 */
export const coexistenceRequestHistorySync = onCall<{ tenantId?: string; phoneNumberId?: string }>(
  { region: 'us-central1', secrets: [META_APP_SECRET] },
  async (req) => {
    const { tenantId, uid } = authorize(req, req.data?.tenantId);
    const phoneNumberId = pnidDe(req.data?.phoneNumberId);
    if (!phoneNumberId) throw new HttpsError('invalid-argument', 'Falta phoneNumberId.');
    // Misma guarda que la decisión: el frontend no puede apuntar el disparo —que es de un solo
    // uso— a un PNID que no sea una conexión de Coexistence de ESTA empresa.
    if (!(await db().doc(paths.metaConnection(tenantId, waConnectionId(phoneNumberId))).get()).exists) {
      throw new HttpsError('failed-precondition', 'Ese número no está conectado por Coexistence en esta empresa.');
    }

    const graph = await getMetaGraphClient();
    const r = await ejecutarSincronizacionDeHistorial(tenantId, phoneNumberId, graph, Date.now());
    if (!r.ok) {
      logger.warn('Coexistence: el disparo del historial se rechazó', { tenantId, motivo: r.motivo });
      throw new HttpsError('failed-precondition', r.explicacion);
    }
    await recordAudit({
      tenantId, action: 'meta.number_added', actorUid: uid, targetType: 'meta', targetId: phoneNumberId,
      summary: 'Se pidió a Meta la sincronización del historial (único disparo posible)',
      metadata: { source: 'coexistence', syncTypes: r.syncTypes },
    });
    return { ok: true, syncTypes: r.syncTypes };
  },
);

/**
 * EVIDENCIA TERMINAL, saneada. Es lo que le permite al Programa 2 auditar el resultado sin abrir
 * una colección con conversaciones adentro: acá no hay ni un wa_id, ni un texto, ni un secreto.
 */
export const coexistenceSyncStatus = onCall<{ tenantId?: string; phoneNumberId?: string }>(
  { region: 'us-central1' },
  async (req) => {
    const { tenantId } = authorize(req, req.data?.tenantId);
    const phoneNumberId = pnidDe(req.data?.phoneNumberId);
    if (!phoneNumberId) throw new HttpsError('invalid-argument', 'Falta phoneNumberId.');

    const connStatus = (await db().doc(paths.metaConnection(tenantId, waConnectionId(phoneNumberId))).get()).data() as { source?: unknown } | undefined;
    const coexistence = esConexionDeCoexistence(connStatus);
    const coord = await leerCoordinador(tenantId, phoneNumberId);
    if (!coord) return { ok: true, exists: false, coexistence };
    const nowMs = Date.now();
    return {
      ok: true,
      exists: true,
      coexistence,
      // El vencimiento se DERIVA en la lectura además de persistirse: un coordinador al que no le
      // llegó ningún chunk después del deadline no tiene quién lo mueva, y mostrar `receiving`
      // sobre una ventana cerrada haría esperar a alguien para siempre.
      status: vencido(coord, nowMs) ? 'expired' : coord.status,
      sharingDecision: coord.sharingDecision ?? null,
      syncGeneration: coord.syncGeneration ?? 1,
      deadlineAtMs: coord.deadlineAt ? coord.deadlineAt.toMillis() : null,
      requestedAtMs: coord.requestedAt ? coord.requestedAt.toMillis() : null,
      lastChunkAtMs: coord.lastChunkAt ? coord.lastChunkAt.toMillis() : null,
      syncTypesRequested: coord.syncTypesRequested ?? [],
      progress: coord.maxProgress ?? null,
      chunks: coord.chunksObservadosCount ?? 0,
      chunksDuplicados: coord.chunksDuplicados ?? 0,
      chunksPendientes: (coord.chunksFallidosPendientes ?? []).length,
      chunksSinTenant: coord.chunksSinTenant ?? 0,
      mediaObservados: coord.mediaObservados ?? 0,
      declineCode: coord.declineCode ?? null,
      errorMessage: coord.errorMessage ?? '',
    };
  },
);
