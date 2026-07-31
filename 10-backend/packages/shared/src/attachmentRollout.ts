/**
 * attachmentRollout.ts — Los DOS interruptores de rollout de la fundación de medios (ADR-0016 §10)
 * =================================================================================================
 * Desplegar la fundación de adjuntos cambia de golpe lo que pasa cuando un cliente manda una foto.
 * Para poder soltarla sin apostar todo a la vez, el encendido es GRADUAL Y POR TENANT, con dos
 * interruptores INDEPENDIENTES que se leen de la config del tenant:
 *
 *   · Nivel A — `config/attachments`, campo `ingest.enabled`: ¿descargamos y guardamos archivos?
 *   · Nivel B — doc `config/receiptGate`, campo `enabled`: ¿proponemos comprobantes?
 *
 * (La purga conserva su propio flag, `config/attachments.retention.purgeEnabled`, en
 * `attachments/retention.ts`: borrar bytes es una decisión distinta de guardar o de clasificar y
 * no se acopla a ninguna de las dos.)
 *
 * POR QUÉ VIVE EN `@vpw/shared` Y NO EN CADA CAMINO: el nivel A lo lee el webhook (`meta/`) y el
 * nivel B lo lee el gate de comprobantes (`orders/`), dos módulos que a propósito no se importan
 * entre sí. Si cada uno escribiera su propia lectura del flag, tarde o temprano una sería más
 * laxa que la otra — y la laxa sería la que enciende. Una sola función, un solo criterio.
 *
 * EL CRITERIO, que es la razón de ser de este archivo: **solo el booleano exacto `true` enciende**.
 * Ausente, `false`, la cadena `'true'`, el número `1`, un objeto o un arreglo significan OFF. La
 * coerción laxa (`!!raw.enabled`, `raw.enabled == true`) es justamente cómo un flag de seguridad
 * termina encendido sin que nadie lo haya decidido: un import de CSV que deja `"true"`, un panel
 * mal tipado que escribe `1`, una migración que copia strings. Fail-closed no es desconfiar del
 * tenant: es que encender una fundación nueva tiene que ser un ACTO, no un accidente de tipos.
 *
 * Funciones PURAS: sin Firestore, sin logging, sin reloj. Quien lee el documento decide qué hacer
 * cuando la lectura misma falla (y ahí también corresponde apagar — ver `getAttachmentIngestPolicy`).
 */

/**
 * El único predicado que enciende algo en todo el rollout. Existe como función —y no como un
 * `=== true` repetido en cada llamador— para que agregar un tercer nivel mañana no sea también
 * agregar una tercera interpretación de "encendido".
 */
export function isRolloutFlagEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * Lee el campo `enabled` de un objeto de configuración CRUDO. Un contenedor que no sea un objeto
 * plano (ausente, string, número, arreglo) no puede tener el flag, así que está apagado.
 * `Array.isArray` se chequea aparte a propósito: un arreglo `[{ enabled: true }]` es `typeof
 * 'object'` y, sin este guard, `raw.enabled` sería `undefined` — apagado por accidente y no por
 * decisión. Mejor que el rechazo sea explícito.
 */
function leerFlagEnabled(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return isRolloutFlagEnabled((raw as { enabled?: unknown }).enabled);
}

/**
 * NIVEL A — ¿guardamos archivos? Recibe el sub-objeto `ingest` del doc `config/attachments` (el
 * MISMO que declara formatos y tope de bytes: un solo documento para toda la política de
 * adjuntos, así quien lo abre ve la foto completa).
 *
 * En OFF: cero llamadas a Graph, cero escritura en Storage, cero documento de adjunto. Pero el
 * inbound NO desaparece —queda un mensaje neutral en la conversación y una respuesta honesta al
 * cliente— y NO se revive el camino legacy de "toda imagen es un comprobante": ese camino se
 * eliminó porque era el defecto.
 */
export function parseAttachmentIngestEnabled(rawIngest: unknown): boolean {
  return leerFlagEnabled(rawIngest);
}

/**
 * NIVEL B — ¿proponemos comprobantes? Recibe los datos CRUDOS del doc `config/receiptGate`.
 *
 * En OFF: un adjunto que se guardó queda `generic_media` y marcar un comprobante RECHAZA. Apagarlo
 * no oculta ni borra nada de lo ya guardado, y desmarcar sigue disponible: apagar una función no
 * puede dejar atrapada una decisión humana que alguien necesita revertir.
 *
 * Quien lo consume debe RELEERLO DENTRO de la transacción que crea el candidato o marca el
 * comprobante (ADR-0016 §10): una lectura vieja no puede ganarle a un apagado ya commiteado.
 */
export function parseReceiptGateEnabled(rawConfig: unknown): boolean {
  return leerFlagEnabled(rawConfig);
}
