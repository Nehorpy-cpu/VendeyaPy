/**
 * functions/meta/metaConnect.ts — Callables de conexión REAL de Meta (Fase 4B)
 * ===========================================================================
 * Flujo Embedded Signup (sin endpoint público de redirect):
 *   startMetaConnect → emite un nonce de un solo uso (TTL corto, atado a tenant+uid).
 *   connectMeta → consume el nonce, intercambia el code, valida, descubre assets y conecta.
 *   verifyMetaChannel → preflight (revalida token/número y actualiza estado).
 *   selectMetaPhoneNumber → elige el phone_number_id activo para el envío.
 *   metaDisconnect → desconecta y borra assets/índice/secreto.
 *
 * Autorización ESTRICTA (meta/authz.ts): solo PLATFORM_ADMIN (con tenant) o TENANT_OWNER
 * de su empresa. TENANT_MANAGER/VIEWER/SELLER: denegado. Nunca se loguean code ni tokens.
 */
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { declaredAutomationMode, parseAutomationMode, masRestrictivo } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { resolveMetaConnectAuth } from '../../meta/authz.js';
import {
  createMetaConnectNonce,
  consumeMetaConnectNonce,
  claimMetaConnectCode,
  parseMetaConnectMode,
  type MetaConnectMode,
} from '../../meta/nonce.js';
import { runMetaConnect, type ConnectFailReason } from '../../meta/connectFlow.js';
import { verifyWhatsappChannel } from '../../meta/preflight.js';
import { selectTenantPhoneNumber } from '../../meta/discovery.js';
import { disconnectMeta } from '../../meta/connect.js';
import { getMetaGraphClient } from '../../meta/graphClient.js';
import { META_APP_SECRET } from '../../meta/metaSecrets.js';
import { assertWhatsappNumbersEntitled } from '../../entitlements/entitlements.js';
import { logger } from '../../lib/logger.js';

interface Authorized {
  tenantId: string;
  uid: string;
}

/** Valida auth + rol/tenant ESTRICTO (owner/admin) y devuelve { tenantId, uid }. */
function authorize(req: CallableRequest<unknown>, requestedTenantId?: string): Authorized {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
  const result = resolveMetaConnectAuth(req.auth.token as { role?: string; tenantId?: string }, requestedTenantId);
  if (!result.ok) throw new HttpsError(result.code, result.message);
  return { tenantId: result.tenantId, uid: req.auth.uid };
}

const CONNECT_FAIL_MESSAGE: Record<ConnectFailReason, string> = {
  exchange_failed: 'No se pudo validar la autorización de Meta. Reintentá el proceso.',
  token_invalid: 'El token de Meta no es válido. Reconectá la cuenta.',
  scopes_insuficientes: 'Faltan permisos de WhatsApp. Aceptá todos los permisos al conectar.',
  no_waba: 'No se encontró una cuenta de WhatsApp Business en tu Meta Business.',
  no_phone_number: 'No se encontró un número de WhatsApp en tu cuenta.',
  phone_number_mismatch: 'El número que elegiste no pertenece a esa cuenta de WhatsApp Business. Reiniciá el proceso y elegí un número de la lista.',
  phone_number_collision: 'Ese número de WhatsApp ya está conectado en otra empresa. Desconectalo de la otra cuenta antes de conectarlo acá.',
  persistencia_incompleta: 'No se pudo guardar la conexión. Tu conexión anterior quedó intacta: reintentá el proceso.',
  over_number_limit: 'Tu plan no alcanza para todos los números de WhatsApp de esta cuenta. Actualizá tu plan o conectá una cuenta con menos números.',
};

/**
 * Lee el modo pedido por el panel. AUSENTE ⇒ `standard`, que es exactamente lo que mandan los
 * clientes anteriores a Coexistence: el flujo estándar no puede regresionar por este cambio.
 *
 * Un valor PRESENTE pero irreconocible se RECHAZA en vez de degradarse a estándar. Degradarlo
 * silenciosamente convertiría un typo en el panel en un onboarding del flujo equivocado sobre el
 * número con el que la empresa vende.
 */
function modoPedido(raw: unknown): MetaConnectMode {
  const modo = parseMetaConnectMode(raw);
  if (modo === null) throw new HttpsError('invalid-argument', 'Tipo de conexión de Meta desconocido.');
  return modo;
}

/**
 * ADR-0017 — ESTA SUPERFICIE SOLO CIERRA ONBOARDINGS ESTÁNDAR. Devuelve el motivo del rechazo, o
 * `null` si el modo es aceptable acá.
 *
 * Estos dos callables corren `runMetaConnect`, y ese camino hace dos cosas que sobre el número real
 * de un negocio en coexistencia son destructivas:
 *
 *  1. guarda el token en el secreto del TENANT (`metaTokenSecretName(tenantId)`, determinístico),
 *     o sea PISA la credencial con la que hoy se le contesta a los clientes;
 *  2. `writeDiscoveredAssets(tenantId, 'main', …)`, cuya limpieza borra todo asset y toda entrada
 *     de índice de la conexión `main` — el asset del número que vende y su ruteo del inbound.
 *
 * Coexistence tiene su propio camino (`coexistenceStart`/`coexistenceConnect` →
 * `runCoexistenceConnect`), que deja el número nuevo en su conexión `wa_{pnid}` y a `main` intacto.
 * Aceptar `mode: 'coexistence'` acá no agregaba ninguna capacidad y dejaba alcanzable el desenlace
 * que el ADR existe para impedir. Es DEFENSA EN PROFUNDIDAD: el panel ya usa los callables
 * correctos, y esto hace que volver a cablearlo mal no llegue a escribir.
 *
 * El rechazo va ANTES de consumir el nonce y de reclamar el `code`: un pedido rechazado no puede
 * gastar el consentimiento del dueño, que en Coexistence no se puede volver a pedir gratis.
 *
 * El flujo estándar NO cambia: `standard` —y el `mode` ausente de los clientes anteriores— pasan.
 */
export function rechazoPorModoEnFlujoEstandar(mode: MetaConnectMode): string | null {
  return mode === 'coexistence'
    ? 'El número que ya usás en WhatsApp Business se conecta desde su propia opción del panel, no por acá.'
    : null;
}

function assertModoEstandar(mode: MetaConnectMode): void {
  const motivo = rechazoPorModoEnFlujoEstandar(mode);
  if (motivo) throw new HttpsError('invalid-argument', motivo);
}

export const startMetaConnect = onCall<{ tenantId?: string; mode?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const mode = modoPedido(req.data?.mode);
  assertModoEstandar(mode);
  const nonce = await createMetaConnectNonce(tenantId, uid, mode);
  logger.info('Meta connect: nonce emitido', { tenantId, mode });
  return { ok: true, nonce, mode };
});

export const connectMeta = onCall<{
  tenantId?: string;
  nonce?: string;
  code?: string;
  /** `standard` | `coexistence` (ADR-0017 §5). Ausente = estándar. */
  mode?: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessId?: string;
  businessName?: string;
  // META_APP_SECRET (Secret Manager): el intercambio del code → token usa el App Secret en graphClient.
}>({ region: 'us-central1', secrets: [META_APP_SECRET] }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const d = req.data ?? {};
  if (!d.code) throw new HttpsError('invalid-argument', 'Falta el code de Meta.');
  const mode = modoPedido(d.mode);
  // Antes de tocar nada: este callable reescribe la conexión `main`. Coexistence va por su camino.
  assertModoEstandar(mode);

  // Entitlements (Fase 5A): el plan debe permitir números de WhatsApp.
  await assertWhatsappNumbersEntitled(tenantId, { actorUid: uid });

  // El nonce está atado al MODO con el que se emitió (ADR-0017 §5): un nonce pedido por el botón
  // estándar no cierra un onboarding de Coexistence ni al revés. Son dos consentimientos distintos
  // del dueño sobre dos cosas distintas, y uno de ellos corre sobre el número que ya vende.
  const nonceOk = await consumeMetaConnectNonce(d.nonce ?? '', { tenantId, uid, mode });
  if (!nonceOk) throw new HttpsError('failed-precondition', 'Sesión de conexión inválida o expirada. Reiniciá el proceso.');

  // El nonce solo garantiza que ESTA sesión de conexión se use una vez; nada impedía pedir otro
  // nonce y reenviar el MISMO `code`. Sin este reclamo, dos llamadas con el mismo code corrían el
  // flujo entero dos veces sobre la conexión que está vendiendo. El reclamo es transaccional, así
  // que también sirve de single-flight entre invocaciones concurrentes.
  const codeOk = await claimMetaConnectCode(d.code, { tenantId, uid, mode });
  if (!codeOk) {
    logger.warn('Meta connect: code ya utilizado (replay o doble envío)', { tenantId, mode });
    throw new HttpsError('failed-precondition', 'Esa autorización de Meta ya fue utilizada. Reiniciá el proceso desde el botón de conectar.');
  }

  // DE ACÁ PARA ABAJO SE ESCRIBE SOBRE LA CONEXIÓN `main`: `runMetaConnect` guarda el token en el
  // secreto del tenant y reescribe los assets de esa conexión. Por eso `mode` ya quedó acotado a
  // `standard` arriba — el razonamiento anterior («el flujo es el mismo para los dos modos») miraba
  // solo el tramo de Graph y pasaba por alto que la PERSISTENCIA no es la misma: en Coexistence el
  // número entra en su propia conexión `wa_{pnid}` (ver `coexistenceConnect`), justamente para no
  // pisar el token ni borrar el asset del número que ya vende.
  // El número recién conectado nace sin `automationMode`, o sea INACTIVO (ADR-0017 §1).
  const graph = await getMetaGraphClient();
  const result = await runMetaConnect(
    tenantId,
    { code: d.code, wabaId: d.wabaId, phoneNumberId: d.phoneNumberId, businessId: d.businessId, businessName: d.businessName },
    uid,
    graph,
  );
  if (!result.ok) {
    logger.warn('Meta connect: falló', { tenantId, mode, reason: result.reason, status: result.status });
    throw new HttpsError('failed-precondition', CONNECT_FAIL_MESSAGE[result.reason]);
  }
  return { ok: true, mode, status: result.status, phoneNumberId: result.selectedPhoneNumberId, phoneNumber: result.phoneNumber, assets: result.assetsCount };
});

export const verifyMetaChannel = onCall<{ tenantId?: string }>({ region: 'us-central1', secrets: [META_APP_SECRET] }, async (req) => {
  const { tenantId } = authorize(req, req.data?.tenantId);
  const graph = await getMetaGraphClient();
  const result = await verifyWhatsappChannel(tenantId, graph);
  return { ok: true, ...result };
});

/** Forma CRUDA de un asset de número tal como viene de Firestore (solo lo que el guard mira). */
interface NumeroParaSeleccion {
  externalId?: unknown;
  automationMode?: unknown;
}

/**
 * ADR-0017 — EL DEFAULT DEL TENANT NO PUEDE DEJAR DE AUTOMATIZAR POR UN CLICK DEL PANEL.
 *
 * `selected: true` es el número que resuelven las credenciales de salida cuando el outbound no
 * sabe por qué número entró el mensaje. Elegir un PNID cuyo `automationMode` resuelve `inactive`
 * (o `shadow`: observar no es responder) mientras OTRO número del tenant está `live` deja al bot
 * callado aunque el panel diga «éxito» — sobre el número con el que la empresa vende.
 *
 * El guard es MÍNIMO a propósito y exige DOS cosas a la vez para rechazar:
 *
 *  1. el destino NO resuelve `live` (por declaración, por basura o por ausencia bajo fail-closed);
 *  2. existe OTRO asset del tenant que DECLARA `live` — hay una automatización encendida que esta
 *     selección apagaría.
 *
 * Sin (2) no se rechaza nada, y eso es lo que protege al mundo PRE-MIGRACIÓN: en producción HOY el
 * asset seleccionado no tiene el campo (el Paso 5 del runbook aún no corrió), nadie declara `live`
 * y la selección sigue funcionando exactamente igual. El cutover completo (elegir + encender +
 * degradar, sin ventana) NO es de este callable: es de la herramienta release-only
 * (`scripts/cutover-whatsapp-number.mjs`). La autorización del callable no cambia.
 *
 * PURA: devuelve el mensaje del rechazo (saneado: sin PNIDs, sin rutas, sin tokens) o `null`.
 */
export function rechazoDeSeleccionPorAutomatizacion(
  destino: NumeroParaSeleccion | null | undefined,
  numeros: ReadonlyArray<NumeroParaSeleccion>,
): string | null {
  // Un destino inexistente no opina: ese caso lo responde el `not-found` de siempre.
  if (!destino) return null;
  // Correctivo (MEDIO 16): el modo EFECTIVO del destino es el MÁS RESTRICTIVO entre asset e
  // índice — el mismo desempate del gate del webhook. Un índice degradado (p. ej. por un
  // `account_update` aplicado a medias) con el asset todavía en `live` dejaba elegir de default
  // un número que el inbound iba a tratar como `inactive`.
  const opinionIndice = declaredAutomationMode((destino as { indiceAutomationMode?: unknown }).indiceAutomationMode);
  const modoEfectivo = masRestrictivo(parseAutomationMode(destino.automationMode), ...(opinionIndice ? [opinionIndice] : []));
  if (modoEfectivo === 'live') return null;
  const hayOtroLive = numeros.some(
    (n) => n !== destino && n.externalId !== destino.externalId && declaredAutomationMode(n.automationMode) === 'live',
  );
  return hayOtroLive
    ? 'Ese número todavía no tiene la automatización encendida: dejarlo como número por defecto apagaría las respuestas automáticas de la empresa. Activalo primero, o hacé el cambio con el proceso de release.'
    : null;
}

export const selectMetaPhoneNumber = onCall<{ tenantId?: string; phoneNumberId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId, uid } = authorize(req, req.data?.tenantId);
  const phoneNumberId = req.data?.phoneNumberId;
  if (!phoneNumberId) throw new HttpsError('invalid-argument', 'Falta phoneNumberId.');
  await assertWhatsappNumbersEntitled(tenantId, { actorUid: uid });
  // ADR-0017: mirar el permiso ANTES de escribir. La lectura es la misma que hace la selección.
  const snap = await db().collection(paths.metaAssets(tenantId)).where('assetType', '==', 'whatsapp_phone_number').get();
  const numeros = snap.docs.map((d) => d.data() as NumeroParaSeleccion);
  const destinoBase = numeros.find((n) => n.externalId === phoneNumberId) ?? null;
  // El índice del DESTINO también opina (una sola lectura extra, solo para el elegido): es la
  // otra mitad del desempate por el más restrictivo que ya aplica el gate del webhook.
  const idxDestino = destinoBase
    ? ((await db().doc(paths.metaExternalIndexEntry(`whatsapp_${phoneNumberId}`)).get()).data() as { automationMode?: unknown } | undefined)
    : undefined;
  const destino = destinoBase ? { ...destinoBase, indiceAutomationMode: idxDestino?.automationMode } : null;
  const motivo = rechazoDeSeleccionPorAutomatizacion(destino, numeros);
  if (motivo) {
    logger.warn('Meta select: rechazado — el destino no automatiza y hay un número live', { tenantId });
    throw new HttpsError('failed-precondition', motivo);
  }
  const ok = await selectTenantPhoneNumber(tenantId, phoneNumberId);
  if (!ok) throw new HttpsError('not-found', 'Ese número no pertenece a la cuenta conectada.');
  return { ok: true, phoneNumberId };
});

export const metaDisconnect = onCall<{ tenantId?: string }>({ region: 'us-central1' }, async (req) => {
  const { tenantId } = authorize(req, req.data?.tenantId);
  await disconnectMeta(tenantId);
  return { ok: true };
});
