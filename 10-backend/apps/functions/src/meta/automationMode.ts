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
  sessionKeyDePlataforma,
  LEGACY_SESSION_KEY,
  CONEXION_HEREDADA,
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
  // El índice opina pero el asset no existe o lo contradice (cierre Codex 2026-08-05, hallazgo 1).
  // Terminal como los demás `inactive` —el sistema SABE que este ruteo no es confiable— pero con
  // nombre propio para que el desenlace sea observable y un reconciliador futuro pueda barrerlo.
  | 'inconsistencia_ruteo'
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
 * Es la ÚNICA puerta del escape —una función con nombre propio, no un `if` suelto en el webhook—
 * para que quien la use tenga que nombrar la excepción, y para cerrar el peor camino posible: que
 * un número de WhatsApp la obtenga. Un veredicto `live` sin pasar por el permiso por número es
 * exactamente lo que ADR-0017 existe para impedir; WhatsApp acá LANZA, siempre.
 *
 * SOBRE SU `sessionKey` (ADR-0017 §2, deuda CERRADA en esta ronda): cada plataforma conversa en
 * su canal PROPIO (`ig` / `msgr`, de `sessionKeyDePlataforma` en `@vpw/shared` — la misma
 * abstracción central que deriva los canales de WhatsApp). Compartir el mutable `active`
 * significaba que un cliente escribiendo por Instagram y por WhatsApp compartía carrito, takeover
 * y estado con el número que vende, y Messenger con Instagram entre sí. Dato verificado de
 * producción (2026-08-04): el índice de ruteo tiene UNA sola entrada y es whatsapp ⇒ no existen
 * conversaciones IG/Messenger reales que el cambio de clave abandone.
 */
export function canalSinGate(platform: string): CanalAutomatizacion {
  if (platform === 'whatsapp') {
    throw new Error('canalSinGate: WhatsApp SIEMPRE pasa por resolveAutomationMode (ADR-0017 §1)');
  }
  return Object.freeze({
    mode: 'live' as WhatsappAutomationMode,
    sessionKey: sessionKeyDePlataforma(platform),
    origen: 'sin_gate' as OrigenAutomatizacion,
  });
}

/** Veredicto cuando no hay nada confiable que leer. */
const CANAL_CERRADO = (origen: OrigenAutomatizacion): CanalAutomatizacion => ({
  mode: AUTOMATION_MODE_FAIL_CLOSED,
  sessionKey: LEGACY_SESSION_KEY,
  origen,
});

/** Forma CRUDA de los dos documentos que pueden declarar algo sobre el canal. */
type DeclaracionCruda =
  | { automationMode?: unknown; sessionKey?: unknown; connectionId?: unknown; tenantId?: unknown; status?: unknown }
  | null;

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
  return raw as Exclude<DeclaracionCruda, null>;
}

/**
 * Cierre Codex 2026-08-05 (hallazgo 1) — ¿el asset RESPALDA el `live` que declara el índice?
 *
 * El índice global es un ESPEJO de ruteo, no la autoridad: la autoridad es el asset del tenant.
 * Un índice que quedó declarando `live` tras un fallo parcial de cutover u offboarding no puede
 * alcanzar por sí solo para dejar pasar el mensaje al motor. Para que su `live` cuente, lo que el
 * asset DECLARA no puede contradecirlo: no estar desactivado por un humano (`status`), ser del
 * MISMO tenant que se está resolviendo y de la MISMA conexión que el índice dice rutear.
 *
 * La ausencia de un campo sigue sin votar (hay documentos anteriores a cada campo): lo que se
 * exige no es que todo esté escrito, sino que NADA de lo escrito se contradiga. La dirección
 * restrictiva del índice (`shadow`/`inactive`) no necesita respaldo — apagar de más es seguro.
 */
function assetRespaldaAlIndice(
  tenantId: string,
  asset: NonNullable<DeclaracionCruda>,
  indice: DeclaracionCruda,
): boolean {
  // Un asset que un humano desactivó no corrobora ningún `live` residual del índice.
  if (asset.status !== undefined && asset.status !== null && asset.status !== 'active') return false;
  // Un índice que rutea hacia OTRO tenant es exactamente la clase de residuo que no puede mandar.
  const tenantDelIndice = indice?.tenantId;
  if (tenantDelIndice !== undefined && tenantDelIndice !== null && tenantDelIndice !== tenantId) return false;
  // Si el índice declara conexión, el asset tiene que ser de ESA conexión. La ausencia del campo
  // en el asset cuenta como la heredada: es lo que ya significa para `derivarSessionKey`.
  const conexionDelIndice = indice?.connectionId;
  if (conexionDelIndice !== undefined && conexionDelIndice !== null) {
    if (conexionDelIndice !== (asset.connectionId ?? CONEXION_HEREDADA)) return false;
  }
  return true;
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

  // Cierre Codex 2026-08-05 (hallazgo 1): un índice residual NO es autoridad. Si el índice OPINA
  // sobre un asset que no existe, eso no es «falta de evidencia» —es una INCONSISTENCIA de ruteo
  // (cutover u offboarding parcial)— y se falla cerrado. Y si opina `live`, el asset además tiene
  // que corroborarlo. La ausencia del asset SIN índice que opine sigue siendo el fail-closed de
  // siempre (`sin_declarar`), y el flujo de la migración (asset `live`, índice callado) no cambia.
  const inconsistente =
    (delIndice !== null && asset === null) ||
    (delIndice === 'live' && asset !== null && !assetRespaldaAlIndice(tenantId, asset, indice));
  if (inconsistente) {
    // Se loguea como WARN sin PNID ni claves: es la señal que el reconciliador futuro va a barrer.
    logger.warn('automationMode: índice de ruteo inconsistente con el asset; queda INACTIVO', {
      tenantId,
      assetExiste: asset !== null,
    });
    // La clave sale de la MISMA autoridad de siempre: con el asset ausente deriva de la conexión
    // `wa_*` que conserve el índice o del PNID — jamás `active` (ver `derivarSessionKey`).
    return {
      mode: AUTOMATION_MODE_FAIL_CLOSED,
      sessionKey: derivarSessionKey(pnid, asset, indice),
      origen: 'inconsistencia_ruteo',
    };
  }
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
