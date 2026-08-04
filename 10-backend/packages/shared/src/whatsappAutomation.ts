/**
 * whatsappAutomation.ts — El permiso para automatizar un número, y el canal de su conversación
 * =============================================================================================
 * ADR-0017 §1. Hasta acá, `status: 'active'` de un asset de WhatsApp significaba dos cosas a la
 * vez: «la credencial sirve» y «el bot puede contestar». Esa confusión es lo que hacía peligroso
 * dar de alta el número real de un negocio que ya está vendiendo: `multiNumber.ts` lo escribe
 * `active` y desde ese instante el webhook lo rutea al motor, delante de clientes de verdad.
 *
 * Se separan en dos ejes ortogonales:
 *   · `status`         — la conexión es válida. NO autoriza nada.
 *   · `automationMode` — `inactive` | `shadow` | `live`: qué se le permite hacer al sistema.
 *
 * EL CRITERIO, igual que en `attachmentRollout.ts` y por la misma razón: **solo uno de los tres
 * strings EXACTOS vale**. `'LIVE'`, `'activo'`, `true`, `1` o un objeto significan `inactive`. La
 * coerción laxa es justamente cómo un permiso termina encendido sin que nadie lo haya decidido —
 * y acá el costo de encenderlo por accidente es que el bot le hable encima al vendedor sobre el
 * número por el que la empresa vende.
 *
 * POR QUÉ VIVE EN `@vpw/shared` Y NO EN EL WEBHOOK: lo leen el gate del inbound, el alta de
 * números, el discovery y la migración. Cuatro lecturas del mismo campo terminan divergiendo, y
 * la más laxa es la que enciende. Una sola función, un solo criterio.
 *
 * Funciones PURAS: sin Firestore, sin logging, sin reloj. Quien lee el documento decide qué hacer
 * cuando la lectura misma falla (y ahí también corresponde apagar).
 */

/**
 * Los tres modos, del MÁS restrictivo al menos. El orden del arreglo ES la escala: `masRestrictivo`
 * la usa para desempatar, así que agregar un modo nuevo obliga a decidir dónde entra.
 *
 * Congelado a propósito: es la referencia que valida documentos venidos de Firestore en runtime,
 * no solo un `as const` que se evapora al compilar.
 */
export const WHATSAPP_AUTOMATION_MODES = Object.freeze(['inactive', 'shadow', 'live'] as const);
export type WhatsappAutomationMode = (typeof WHATSAPP_AUTOMATION_MODES)[number];

/** A dónde cae todo lo que no se entiende. Existe como constante para que nadie lo re-elija. */
export const AUTOMATION_MODE_FAIL_CLOSED: WhatsappAutomationMode = 'inactive';

/** ¿Es exactamente uno de los tres strings? Es el único predicado que reconoce un modo. */
export function isWhatsappAutomationMode(value: unknown): value is WhatsappAutomationMode {
  return typeof value === 'string' && (WHATSAPP_AUTOMATION_MODES as readonly string[]).includes(value);
}

/**
 * Lee un valor CRUDO y devuelve el modo. Cualquier cosa que no sea uno de los tres strings
 * exactos es `inactive`: un PNID nuevo, un campo ausente, un panel que escribió `'Live'`.
 */
export function parseAutomationMode(value: unknown): WhatsappAutomationMode {
  return isWhatsappAutomationMode(value) ? value : AUTOMATION_MODE_FAIL_CLOSED;
}

/**
 * La distinción que hace desplegable a ADR-0017: **AUSENTE no es lo mismo que MAL ESCRITO**.
 *
 * `null` ⇒ la fuente no opina (no tiene el campo). `inactive` ⇒ la fuente opina que no, sea
 * porque lo dice o porque escribió algo irreconocible.
 *
 * Por qué importa: el modo vive en el asset y se puede espejar en el índice de ruteo. Si la
 * AUSENCIA en el índice votara `inactive`, el desempate por el más restrictivo dejaría mudo al
 * número que vende hasta que alguien escribiera el campo en los dos documentos a la vez. La
 * ausencia no es una opinión; lo irreconocible sí, y ahí sí se falla cerrado.
 */
export function declaredAutomationMode(value: unknown): WhatsappAutomationMode | null {
  if (value === undefined || value === null) return null;
  return parseAutomationMode(value);
}

/**
 * El desempate del ADR: «ante inconsistencia entre asset, índice y conexión gana el estado más
 * restrictivo». Sin argumentos devuelve `inactive` — nadie declaró nada, no se automatiza.
 */
export function masRestrictivo(...modos: readonly unknown[]): WhatsappAutomationMode {
  let ganador: WhatsappAutomationMode = modos.length === 0 ? AUTOMATION_MODE_FAIL_CLOSED : 'live';
  for (const crudo of modos) {
    const modo = parseAutomationMode(crudo);
    if (WHATSAPP_AUTOMATION_MODES.indexOf(modo) < WHATSAPP_AUTOMATION_MODES.indexOf(ganador)) ganador = modo;
  }
  return ganador;
}

/** ¿El sistema puede responder, cobrar metering, ingerir archivos y mover pedidos? Solo `live`. */
export function permiteAutomatizacion(mode: WhatsappAutomationMode): boolean {
  return mode === 'live';
}

/**
 * ¿El mensaje entrante se guarda? `shadow` existe justamente para poder MIRAR lo que llega antes
 * de dejar que el sistema actúe; `inactive` no deja rastro conversacional (ACK y nada más).
 */
export function persisteEntrante(mode: WhatsappAutomationMode): boolean {
  return mode === 'shadow' || mode === 'live';
}

// ---------------------------------------------------------------------------
// ADR-0017 §2 — La conversación es por canal
// ---------------------------------------------------------------------------

/**
 * La clave del canal HEREDADO. Todas las conversaciones que existen hoy viven en
 * `sessions/active` y **no se migran**: esa clave se conserva para el número que ya vende, y los
 * números que se sumen estrenan la suya. Cambiar este valor sería mudar de golpe el carrito, el
 * takeover y el pedido pendiente de todos los clientes vivos.
 */
export const LEGACY_SESSION_KEY = 'active';

/** Charset de un id de documento seguro: sin `/`, sin puntos, sin espacios, sin acentos. */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** ¿Sirve como id del documento de sesión? Se valida en runtime porque viene de Firestore. */
export function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && SESSION_KEY_RE.test(value);
}

/**
 * Clave del canal de un número. Determinística y con prefijo propio para que jamás pueda
 * colisionar con `active`.
 *
 * Sin PNID no hay canal propio que derivar: es el caso de un inbound sin número receptor, y ahí
 * la respuesta correcta es el canal heredado (que es donde ya viven esas conversaciones).
 */
export function whatsappSessionKey(phoneNumberId: string): string {
  const limpio = String(phoneNumberId ?? '').trim();
  if (limpio === '') return LEGACY_SESSION_KEY;
  // El PNID de Meta son dígitos, pero se sanea igual: esta cadena termina siendo un SEGMENTO DE
  // PATH y un valor con `/` escribiría en otra colección.
  const seguro = limpio.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return `wa_${seguro}`;
}

/** Lee una clave CRUDA; si no sirve como id de documento, decide el llamador con `fallback`. */
export function parseSessionKey(value: unknown, fallback: string): string {
  return isSessionKey(value) ? value : fallback;
}
