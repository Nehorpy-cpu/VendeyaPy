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
  derivarSessionKey,
  masRestrictivo,
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
 *
 * SOBRE SU `sessionKey` (ETAPA E, deuda DECLARADA): sigue siendo `active`, que es donde viven hoy
 * las conversaciones de Instagram y Messenger. Darles canal propio ahora las dejaría HUÉRFANAS —
 * carrito, takeover y pedido pendiente de charlas vivas apuntando a un documento que nadie
 * escribió—, y eso es una migración de datos, no un cambio aditivo. No hay colisión con WhatsApp
 * porque el `customerId` de esas plataformas no es un teléfono sino el id que asigna Meta, así que
 * son documentos de clientes distintos. Queda pendiente para el programa que migre esas
 * conversaciones; mientras tanto el fallback es explícito y está probado, no un default silencioso.
 */
export const CANAL_SIN_GATE: CanalAutomatizacion = Object.freeze({
  mode: 'live' as WhatsappAutomationMode,
  sessionKey: LEGACY_SESSION_KEY,
  origen: 'sin_gate' as OrigenAutomatizacion,
});

/**
 * La ÚNICA puerta para usar el escape, y existe para cerrar el peor camino posible: que un número
 * de WhatsApp lo obtenga. Ese objeto dice `live` Y `active` a la vez, o sea «automatizá y hacelo
 * sobre la conversación del número que ya vende» — exactamente lo que ADR-0017 existe para impedir.
 * Hoy el webhook no lo hace; esto lo vuelve imposible de hacer por descuido en un refactor, en vez
 * de dejarlo dependiendo de que nadie toque un ternario.
 */
export function canalSinGate(platform: string): CanalAutomatizacion {
  if (platform === 'whatsapp') {
    throw new Error('canalSinGate: WhatsApp SIEMPRE pasa por resolveAutomationMode (ADR-0017 §1)');
  }
  return CANAL_SIN_GATE;
}

/** Veredicto cuando no hay nada confiable que leer. */
const CANAL_CERRADO = (origen: OrigenAutomatizacion): CanalAutomatizacion => ({
  mode: AUTOMATION_MODE_FAIL_CLOSED,
  sessionKey: LEGACY_SESSION_KEY,
  origen,
});

/** Forma CRUDA de los dos documentos que pueden declarar algo sobre el canal. */
type DeclaracionCruda = { automationMode?: unknown; sessionKey?: unknown; connectionId?: unknown } | null;

/**
 * LA AUTORIDAD para derivar el canal, re-exportada desde acá porque este módulo es la puerta del
 * permiso por número: quien resuelve «¿puede automatizar?» resuelve también «¿en qué conversación?»
 * y no puede haber dos respuestas. La implementación vive en `@vpw/shared` por una razón concreta:
 * el script de migración es un `.mjs` que corre suelto contra Firestore y no puede importar el
 * bundle de functions — cuando cada lado tenía su copia, divergieron (ver `derivarSessionKey`).
 */
export { derivarSessionKey } from '@vpw/shared';

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

  // El canal sale de la MISMA función que usa el script de migración (ver `derivarSessionKey`):
  // dos derivaciones del mismo campo terminan divergiendo, y la laxa es la que comparte sesión
  // con el número que ya vende.
  const sessionKey = derivarSessionKey(pnid, asset, indice);

  const origen: OrigenAutomatizacion =
    opiniones.length === 0 ? 'sin_declarar' : delAsset !== null && masRestrictivo(delAsset) === mode ? 'asset' : 'indice';

  return { mode, sessionKey, origen };
}
