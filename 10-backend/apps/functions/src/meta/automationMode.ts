/**
 * meta/automationMode.ts — ¿Este número puede automatizar? (ADR-0017 §1)
 * =======================================================================
 * El lector CON I/O del permiso por número. La aritmética de los modos vive en `@vpw/shared`
 * (`whatsappAutomation.ts`) y acá se resuelve lo otro: qué documentos se miran, cómo se desempata
 * entre ellos y qué pasa cuando la lectura misma se cae.
 *
 * DÓNDE VIVE EL PERMISO. El asset del número (`tenants/{t}/metaAssets/{pnid}`) es la AUTORIDAD:
 * es el documento por número, el que el discovery reescribe y el que la migración toca. El índice
 * global de ruteo puede espejarlo, y si lo hace, su opinión también cuenta — pero solo si la tiene
 * escrita. La ausencia en el índice NO vota (ver `declaredAutomationMode`): si votara, la
 * migración tendría que escribir dos documentos en el mismo instante o el número que vende
 * quedaría mudo en el medio.
 *
 * FAIL-CLOSED, con el mismo criterio que `getAttachmentIngestPolicy` (ADR-0016 §10): sin asset,
 * sin campo, con un valor irreconocible o con Firestore intermitente ⇒ `inactive`. Habilitar un
 * número tiene que ser un ACTO, y un error de infraestructura no es un acto.
 *
 * El costo es UNA lectura por evento. Es el mismo orden de magnitud que el gate de empresa que
 * viene inmediatamente después, y compra la garantía de que ningún número contesta sin permiso.
 */
import {
  declaredAutomationMode,
  masRestrictivo,
  parseSessionKey,
  whatsappSessionKey,
  LEGACY_SESSION_KEY,
  AUTOMATION_MODE_FAIL_CLOSED,
  type WhatsappAutomationMode,
} from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

/** De dónde salió el veredicto. Código CERRADO: es seguro de loguear (no lleva datos de nadie). */
export type OrigenAutomatizacion =
  | 'asset'
  | 'indice'
  | 'sin_declarar'
  | 'sin_pnid'
  | 'error_lectura'
  | 'sin_gate';

export interface CanalAutomatizacion {
  /** Qué se le permite hacer al sistema con este número. */
  mode: WhatsappAutomationMode;
  /** Documento de sesión de ESTE canal (ADR-0017 §2). `active` = canal heredado. */
  sessionKey: string;
  origen: OrigenAutomatizacion;
}

/**
 * El escape EXPLÍCITO para lo que no es un número de WhatsApp. Instagram y Messenger no tienen
 * `phone_number_id` que autorizar y ya tienen su propio gate (la feature `multiChannel` del plan):
 * meterlos en el fail-closed de ADR-0017 los apagaría a todos de golpe al desplegar, que es
 * exactamente el tipo de regresión que este programa existe para evitar.
 *
 * Es una constante congelada y con nombre propio —y no un `if` suelto en el webhook— para que
 * quien la use tenga que nombrar la excepción.
 */
export const CANAL_SIN_GATE: CanalAutomatizacion = Object.freeze({
  mode: 'live' as WhatsappAutomationMode,
  sessionKey: LEGACY_SESSION_KEY,
  origen: 'sin_gate' as OrigenAutomatizacion,
});

/** Veredicto cuando no hay nada confiable que leer. */
const CANAL_CERRADO = (origen: OrigenAutomatizacion): CanalAutomatizacion => ({
  mode: AUTOMATION_MODE_FAIL_CLOSED,
  sessionKey: LEGACY_SESSION_KEY,
  origen,
});

/** Forma CRUDA de los dos documentos que pueden declarar algo sobre el canal. */
type DeclaracionCruda = { automationMode?: unknown; sessionKey?: unknown; connectionId?: unknown } | null;

/**
 * La conexión del número HEREDADO: la única que existía cuando había un número por tenant. Los
 * números adicionales viven en `wa_{pnid}` (ver `multiNumber.ts`).
 */
const CONEXION_HEREDADA = 'main';

/**
 * ¿Este asset es el del canal heredado? Solo importa cuando NADIE declaró `sessionKey`.
 *
 * El desempate NO puede ser `selected`: un admin lo cambia al elegir el remitente por defecto y
 * eso le mudaría el canal al número que está vendiendo, con carrito, takeover y checkout vivos
 * adentro. `connectionId` no lo toca ninguna acción de panel: un número que entró como adicional
 * tiene el suyo y no puede reclamar el canal del que vende.
 *
 * Un asset sin `connectionId` (o directamente ausente) cuenta como heredado: son los documentos
 * escritos antes de que el campo existiera, y ahí `active` es efectivamente donde viven sus
 * conversaciones.
 */
function esConexionHeredada(asset: DeclaracionCruda): boolean {
  const conexion = asset?.connectionId;
  return conexion === undefined || conexion === null || conexion === CONEXION_HEREDADA;
}

/**
 * Los tipos de `MetaAsset` y `MetaExternalIndexEntry` todavía no declaran estos campos —son
 * ADITIVOS y conviven con documentos que no los tienen—, así que acá se entra por `unknown` y se
 * estrecha en runtime. Es el mismo criterio que el resto de los lectores fail-closed: el tipo de
 * un documento de Firestore es una promesa, no una garantía.
 */
function leerDeclaracion(raw: unknown): DeclaracionCruda {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as { automationMode?: unknown; sessionKey?: unknown };
}

/**
 * Resuelve el permiso y el canal de un `phone_number_id` dentro de un tenant.
 *
 * @param idxData datos CRUDOS de la entrada del índice, si el llamador ya la leyó para resolver
 *   el tenant. Se pasan para no pagar la lectura dos veces; si no vienen, se leen acá.
 */
export async function resolveAutomationMode(
  tenantId: string,
  phoneNumberId: string | null | undefined,
  idxData?: unknown,
): Promise<CanalAutomatizacion> {
  const pnid = (phoneNumberId ?? '').trim();
  if (!tenantId || pnid === '') return CANAL_CERRADO('sin_pnid');

  let asset: DeclaracionCruda = null;
  let indice: DeclaracionCruda = leerDeclaracion(idxData);
  try {
    const snap = await db().doc(paths.metaAsset(tenantId, pnid)).get();
    asset = leerDeclaracion(snap.data());
    // `undefined` = «el llamador no lo leyó»; `null` = «lo leyó y no había nada». Solo en el
    // primer caso se paga la lectura, para no duplicar la que el webhook ya hizo.
    if (idxData === undefined) {
      const idxSnap = await db().doc(paths.metaExternalIndexEntry(`whatsapp_${pnid}`)).get();
      indice = leerDeclaracion(idxSnap.data());
    }
  } catch (e) {
    // Mismo criterio que el nivel A de adjuntos: el FLAG falla cerrado. Se loguea el nombre del
    // error, nunca el número ni el mensaje del cliente.
    logger.warn('automationMode: no se pudo leer el permiso del número; queda INACTIVO', {
      tenantId,
      error: e instanceof Error ? e.name : 'desconocido',
    });
    return CANAL_CERRADO('error_lectura');
  }

  // Solo las fuentes que DECLARAN algo participan del desempate; si ninguna declara, no se
  // automatiza (la lista vacía ya devuelve `inactive`).
  const opiniones: WhatsappAutomationMode[] = [];
  const delAsset = declaredAutomationMode(asset?.automationMode);
  const delIndice = declaredAutomationMode(indice?.automationMode);
  if (delAsset !== null) opiniones.push(delAsset);
  if (delIndice !== null) opiniones.push(delIndice);
  const mode = masRestrictivo(...opiniones);

  /**
   * La clave del canal, con una asimetría deliberada:
   *  · AUSENTE Y CONEXIÓN HEREDADA ⇒ canal heredado (`active`). Es el asset del número que ya
   *    vende, escrito antes de ADR-0017: sus conversaciones viven ahí y no se migran.
   *  · AUSENTE PERO DE OTRA CONEXIÓN ⇒ se DERIVA del PNID. Un número adicional no puede heredar
   *    el canal del que vende solo por no declarar nada: al pasar a `live` compartiría carrito,
   *    estado de checkout y takeover con él.
   *  · PRESENTE PERO MALFORMADA ⇒ se DERIVA del PNID. Caer a `active` fusionaría la conversación
   *    de este número con la del que ya vende: ante basura, la opción segura es la que nunca
   *    comparte.
   */
  const declarada = asset?.sessionKey ?? indice?.sessionKey;
  const propia = whatsappSessionKey(pnid);
  const sessionKey =
    declarada === undefined || declarada === null
      ? esConexionHeredada(asset) ? LEGACY_SESSION_KEY : propia
      : parseSessionKey(declarada, propia);

  const origen: OrigenAutomatizacion =
    opiniones.length === 0 ? 'sin_declarar' : delAsset !== null && masRestrictivo(delAsset) === mode ? 'asset' : 'indice';

  return { mode, sessionKey, origen };
}
