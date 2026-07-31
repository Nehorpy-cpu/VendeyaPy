/**
 * meta/attachmentReplies.ts — QUÉ se le contesta al cliente por un archivo (ADR-0016 §4)
 * =======================================================================================
 * ADR-0016 §4 es explícito: «un rechazo **nunca** bloquea la conversación: se responde al cliente
 * y queda rastro visible en el chat». El defecto que este módulo cierra es el SILENCIO TOTAL: la
 * ingesta terminaba bien, el gate degradaba a `generic_media` con `reply: ''`, el caption ya no se
 * promovía a texto ⇒ el motor no corría ⇒ NO salía ni un solo mensaje. Un cliente que manda el PDF
 * del banco creía que nadie lo había visto.
 *
 * La redacción NO es nueva: es la que ya estaba escrita y pensada en `orders/comprobanteImage.ts`
 * (`respuestaPorMotivo`). Vive acá —y no allá— porque la conversación no puede depender del camino
 * de pago: `meta/` jamás importa `orders/` (esa es toda la razón de ser de la costura del gate).
 *
 * Dos reglas que gobiernan cada texto:
 *  1. HONESTIDAD. Nunca promete que el pago quedó confirmado, nunca culpa al cliente y nunca dice
 *     que puede ver el contenido del archivo (la visión está diferida — ADR-0016 §9).
 *  2. CERO VERTICAL (ADR-0016 §8). Ninguna frase nombra un rubro: sirven igual para perfumería,
 *     para créditos o para lo que venga. Lo único que se adapta es el sustantivo del archivo,
 *     porque decirle "imagen" a un PDF del banco es sencillamente falso.
 */

/** Clase técnica del adjunto (la misma del documento). Decide el sustantivo, nada más. */
export type AttachmentReplyClass = 'image' | 'document' | 'unknown';

/**
 * Motivo por el que hay algo que contestar. Códigos CERRADOS ⇒ seguros de loguear: no llevan
 * teléfono, ni mediaId, ni rutas.
 *
 * Los tres primeros los produce la INGESTA (`meta/`). El resto los produce el gate de
 * clasificación, que vive del lado de pedidos: la lista se replica acá a propósito para no
 * importar `orders/` desde el webhook, y un test de tipos verifica que siga siendo un
 * SUPERCONJUNTO de `ReceiptGateDenyReason` (si allá se agrega un motivo, este archivo falla).
 */
export type AttachmentReplyReason =
  // --- ingesta ---
  | 'too_large'
  | 'unsupported_type'
  | 'download_failed'
  // --- gate de clasificación ---
  | 'tenant_mismatch'
  | 'customer_mismatch'
  | 'classification_not_open'
  | 'no_explicit_payment_context'
  | 'no_admissible_order'
  | 'ambiguous_orders'
  | 'order_customer_mismatch'
  | 'order_not_admissible'
  | 'order_already_paid'
  | 'outside_time_window'
  | 'attachment_not_stored'
  | 'attachment_purged'
  | 'mime_not_allowed'
  | 'size_not_allowed';

/** Respuestas NEUTRAS de la ingesta. Sin sustantivo de clase: valen para foto y para PDF. */
export const ATTACHMENT_REPLIES = {
  too_large: 'Ese archivo pesa demasiado 😅 ¿Me lo mandás de nuevo en menor calidad?',
  unsupported_type: 'Ese formato no lo puedo abrir 😅 Mandámelo como foto (JPG/PNG) o PDF, porfa.',
  download_failed: 'No pude descargar tu archivo 😕 ¿Me lo reenviás?',
} as const;

/** Concordancia de género/número para que el mismo texto sirva a "imagen" y a "archivo". */
interface Sustantivo {
  /** "tu imagen" · "tu archivo" */
  tu: string;
  /** Pronombre acusativo: "la" · "lo" */
  lo: string;
  /** Adjetivo concordado: "completa" · "completo" */
  completo: string;
  /** Sufijo de infinitivo + pronombre: "vincularla" · "vincularlo" */
  vincular: string;
}

const IMAGEN: Sustantivo = { tu: 'tu imagen', lo: 'la', completo: 'completa', vincular: 'vincularla' };
const ARCHIVO: Sustantivo = { tu: 'tu archivo', lo: 'lo', completo: 'completo', vincular: 'vincularlo' };

const sustantivo = (clase: AttachmentReplyClass): Sustantivo => (clase === 'image' ? IMAGEN : ARCHIVO);

/**
 * Texto para el cliente. `reason` ausente/desconocido ⇒ el caso GENÉRICO, que es el correcto por
 * defecto: sin contexto explícito de pago un archivo es simplemente un archivo (ADR-0016 §4), se
 * deja en la conversación y se le dice al cliente cómo seguir. Nunca devuelve cadena vacía: el
 * llamador la usa como garantía de que ninguna recepción queda muda.
 */
export function respuestaPorAdjunto(
  reason: AttachmentReplyReason | null | undefined,
  clase: AttachmentReplyClass = 'unknown',
): string {
  const s = sustantivo(clase);
  switch (reason) {
    // --- ingesta: el archivo NO quedó guardado, y eso hay que decirlo sin vueltas ---
    case 'too_large':
    case 'size_not_allowed':
      return ATTACHMENT_REPLIES.too_large;
    case 'unsupported_type':
    case 'mime_not_allowed':
      return ATTACHMENT_REPLIES.unsupported_type;
    case 'download_failed':
      return ATTACHMENT_REPLIES.download_failed;
    case 'attachment_not_stored':
      return `Recibí ${s.tu} 🙂 pero no ${s.lo} pude guardar ${s.completo}. ¿Me ${s.lo} reenviás?`;
    // El archivo existió pero sus bytes ya se borraron por retención: pedirlo de nuevo es lo único
    // honesto que se puede decir. Nunca se llega acá con un adjunto vinculado a un pedido — la
    // purga los excluye por diseño (ADR-0016 §6).
    case 'attachment_purged':
      return `Recibí ${s.tu} 🙂 pero ya no ${s.lo} tengo guardad${clase === 'image' ? 'a' : 'o'} por antigüedad. ¿Me ${s.lo} reenviás?`;

    // --- gate: el archivo SÍ está guardado; lo que no se pudo fue darle significado de pago ---
    case 'no_admissible_order':
    case 'order_not_admissible':
      return (
        `Recibí ${s.tu} 🙂 pero no encuentro un pedido pendiente tuyo. Si querés comprar, ` +
        'escribí *catálogo* y armamos tu pedido; si ya pagaste algo, un asesor te contacta enseguida.'
      );
    case 'ambiguous_orders':
      return (
        'Recibí tu comprobante 🙌 pero tenés más de un pedido pendiente y no quiero confundirlos. ' +
        'Un asesor lo asigna enseguida — si podés, respondé con el total que pagaste.'
      );
    case 'order_already_paid':
      return `Recibí ${s.tu} 🙌 Tu pedido ya figura pagado, así que no hace falta nada más. Si necesitás algo, un asesor te ayuda.`;
    case 'outside_time_window':
      return `Recibí ${s.tu} 🙌 Como tu pedido ya lleva un tiempo, prefiero que lo revise un asesor antes de darlo por pagado.`;

    // --- genérico: incluye `no_explicit_payment_context` y los mismatch de tenant/cliente, que
    //     JAMÁS se le explican al cliente (son problemas nuestros, no suyos) ---
    default:
      return (
        `Recibí ${s.tu} 🙂 ${s.lo} dejo en la conversación. Si es el comprobante de una transferencia, ` +
        `escribí *pagar* y te paso los datos para ${s.vincular} a tu pedido.`
      );
  }
}
