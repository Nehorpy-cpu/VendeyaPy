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

/**
 * La conexión del número HEREDADO: la única que existía cuando había un número por tenant. Los
 * números adicionales estrenan la suya (`wa_{pnid}`, ver `multiNumber.ts`).
 */
export const CONEXION_HEREDADA = 'main';

// ---------------------------------------------------------------------------
// ADR-0017 §2 aplicado a las plataformas SIN número: Instagram y Messenger
// ---------------------------------------------------------------------------

/**
 * Clave de canal por PLATAFORMA. Instagram y Messenger no tienen `phone_number_id` del que derivar
 * canal, y hasta esta ronda compartían el mutable `active`: un cliente que escribía por Instagram
 * y por WhatsApp compartía carrito, takeover y estado con el número que vende — y Messenger con
 * Instagram entre sí. Cada plataforma estrena la suya.
 *
 * COMPATIBILIDAD (dato verificado de producción, 2026-08-04, no re-derivar): el índice de ruteo
 * tiene UNA sola entrada y es whatsapp ⇒ no existen conversaciones IG/Messenger reales que este
 * cambio abandone. Las claves son cortas, estables y de documento válido; cambiarlas después SÍ
 * sería una migración de datos.
 *
 * Vive acá —la MISMA abstracción central que las claves de WhatsApp— por la razón de siempre:
 * dos construcciones del mismo canal terminan divergiendo, y la laxa es la que comparte sesión.
 */
export const PLATFORM_SESSION_KEYS = Object.freeze({
  instagram: 'ig',
  messenger: 'msgr',
} as const);

/**
 * El canal PROPIO de una plataforma sin PNID. Solo el string EXACTO mapea (mismo criterio que
 * `parseAutomationMode`): una variante rara no puede terminar en el canal de la plataforma real.
 * Una plataforma que este código no conoce JAMÁS comparte canal — ni `active`, ni `wa_*`, ni el
 * de otra—: estrena una clave derivada con prefijo propio y saneo de id de documento (la cadena
 * termina siendo un segmento de path, misma razón que `whatsappSessionKey`).
 *
 * WhatsApp LANZA: su canal se deriva del PNID (`whatsappSessionKey` / `derivarSessionKey`) y una
 * respuesta "por defecto" acá sería exactamente la clase de default silencioso que ADR-0017 veda.
 */
export function sessionKeyDePlataforma(platform: string): string {
  const nombre = String(platform ?? '');
  if (nombre === 'whatsapp' || nombre.trim() === '') {
    throw new Error('sessionKeyDePlataforma: el canal de WhatsApp se deriva del PNID (ADR-0017 §2)');
  }
  const conocida = (PLATFORM_SESSION_KEYS as Readonly<Record<string, string>>)[nombre];
  if (conocida !== undefined) return conocida;
  return `ch_${nombre.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}`;
}

/** Forma CRUDA de un documento que puede declarar algo sobre el canal (asset o índice). */
export interface DeclaracionDeCanal {
  sessionKey?: unknown;
  connectionId?: unknown;
}

/**
 * ¿Este asset es el del canal heredado? Solo importa cuando NADIE declaró `sessionKey`.
 *
 * El desempate NO puede ser `selected`: un admin lo cambia al elegir el remitente por defecto y
 * eso le mudaría el canal al número que está vendiendo, con carrito, takeover y checkout vivos
 * adentro. `connectionId` no lo toca ninguna acción de panel.
 *
 * Un asset sin `connectionId` (o directamente ausente) cuenta como heredado: son los documentos
 * escritos antes de que el campo existiera, y ahí `active` es efectivamente donde viven sus
 * conversaciones.
 */
function esConexionHeredada(asset: DeclaracionDeCanal | null | undefined): boolean {
  const conexion = asset?.connectionId;
  return conexion === undefined || conexion === null || conexion === CONEXION_HEREDADA;
}

/**
 * LA ÚNICA AUTORIDAD para derivar el canal de un número (ADR-0017 §2).
 *
 * Vive en `@vpw/shared` y no en el webhook por la misma razón que `parseAutomationMode`: la leen
 * el resolvedor del inbound, el alta de números y el script de migración —que es un `.mjs` suelto
 * y NO puede importar el bundle de functions—. Cuando esto vivía en dos lados, divergieron: el
 * resolvedor aceptaba una `sessionKey` declarada solo en el índice y el script solo miraba el
 * asset, así que el mismo número quedaba ruteado a `active` por el webhook y considerado «canal
 * propio» por la migración. Las dos mitades opinando distinto sobre el mismo número es exactamente
 * cómo un número nuevo termina compartiendo carrito y takeover con el que ya vende.
 *
 * Las tres reglas, en orden:
 *  1. NADIE declara ⇒ el asset de la conexión heredada va a `active`; cualquier otro estrena la
 *     suya. Un número adicional no puede heredar el canal del que vende por no declarar nada.
 *  2. Declaración MALFORMADA ⇒ se deriva del PNID. Ante basura, la opción segura es la que nunca
 *     comparte.
 *  3. Una declaración que manda el número al canal HEREDADO solo vale si el asset ES el heredado.
 *     El canal del número que ya vende no se reclama por un espejo del índice ni por un valor
 *     viejo que quedó dando vueltas en el documento.
 */
export function derivarSessionKey(
  phoneNumberId: string,
  asset: DeclaracionDeCanal | null | undefined,
  indice?: DeclaracionDeCanal | null | undefined,
): string {
  const propia = whatsappSessionKey(phoneNumberId);
  const declarada = asset?.sessionKey ?? indice?.sessionKey;
  if (declarada === undefined || declarada === null) {
    return esConexionHeredada(asset) ? LEGACY_SESSION_KEY : propia;
  }
  const leida = parseSessionKey(declarada, propia);
  if (leida === LEGACY_SESSION_KEY && !esConexionHeredada(asset)) return propia;
  return leida;
}
