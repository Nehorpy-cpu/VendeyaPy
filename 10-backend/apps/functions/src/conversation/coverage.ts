/**
 * COVERAGE-1B — Máquina de estados de cobertura de envío (solicitud de ubicación).
 * ================================================================================
 * Con `coverage.enabled` en la config del tenant, "quiero pagar" NO crea la orden ni muestra
 * datos bancarios: primero se pide la ubicación (nativa de WhatsApp o dirección escrita) y el
 * request queda `pending_coverage_review` con handoff `coverage_review` para revisión humana (1C).
 *
 * GARANTÍAS (contrato 1B):
 *  - Flag ausente/false ⇒ el checkout actual queda EXACTAMENTE igual.
 *  - La ubicación exacta vive SOLO en `tenants/{t}/coverageRequests/{id}` — jamás en mensajes,
 *    logs, prompts de IA ni notificaciones. La sesión guarda un puntero sin PII.
 *  - Creación/reuso de request TRANSACCIONAL sobre la sesión: dos "pagar" concurrentes → 1 request.
 *  - La aprobación (1C) valdrá para la UBICACIÓN (locationFingerprint) durante su vigencia;
 *    `cartSnapshot`/`cartFingerprint` son contexto, y `checkoutAttemptId` (1D) llevará la
 *    idempotencia del pedido por separado.
 *  - Nunca se crea orden, se muestra banco, se toca stock ni pagos desde este módulo.
 */
import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type {
  Cart,
  CheckoutConfig,
  CoverageLocation,
  CoverageRequest,
  CoverageSessionPointer,
  CoverageStatus,
  MessageChannel,
  Session,
} from '@vpw/shared';
import { newCoverageRequestId, coverageActivationOf, shippingQuotePolicyOf, maskPhone } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { getCheckoutConfig, pickSeller } from '../orders/checkoutConfig.js';
import { executeHandoff, notifyHandoffRequested } from './handoff.js';
import { esConsultaCobertura } from './coverageGuard.js';
import { coverageHold } from './coverageTestHooks.js';
import { appendMessage } from './messages.js';
import type { InboundLocation } from '../meta/parseWebhook.js';

// ---------------------------------------------------------------------------
// Config del tenant (validada server-side; ausente/ inválida ⇒ deshabilitado)
// ---------------------------------------------------------------------------

export interface ResolvedCoverageConfig {
  enabled: boolean;
  /** HARDEN-1: activación vigente. null ⇔ enabled false (el contrato exige un id válido). */
  activationId: string | null;
  expiryHours: number;
  requestMessage: string;
  rejectedMessage: string | null;
}

const EXPIRY_DEFAULT_HOURS = 24;
const EXPIRY_MAX_HOURS = 24 * 30; // tope defensivo: 30 días
const MESSAGE_MAX = 600;

/** Mensaje default de solicitud: botón nativo + SIEMPRE la alternativa textual. */
export const MENSAJE_SOLICITUD_UBICACION =
  '📍 Antes de cobrarte necesitamos confirmar que llegamos a tu zona.\n' +
  'Compartí tu ubicación tocando el botón de abajo (o el clip 📎 → *Ubicación*), ' +
  'o escribime tu dirección con *ciudad, barrio, calle y una referencia*.';

export const MENSAJE_UBICACION_EN_REVISION =
  'Tu ubicación ya está en revisión 🙌 Apenas el equipo confirme la cobertura seguimos con tu pedido por acá.';

export const MENSAJE_UBICACION_RECIBIDA =
  'Recibí tu ubicación ✅ El equipo va a confirmar la cobertura de tu zona y seguimos con tu pedido por acá.';

export const MENSAJE_UBICACION_ACTUALIZADA =
  'Actualicé tu ubicación ✅ El equipo la revisa y seguimos por acá.';

export const MENSAJE_UBICACION_SIN_PEDIDO =
  'Recibí tu ubicación 📍 Para usarla en una entrega, primero armá tu pedido y escribí *pagar* — ahí te la vuelvo a pedir.';

export const MENSAJE_ZONA_YA_CONFIRMADA =
  'Tu zona ya está confirmada ✅ Escribí *pagar* para continuar con tu pedido.';

/** Variante SIN botón (Instagram/Messenger u otro canal sin location_request_message). */
export const MENSAJE_SOLICITUD_UBICACION_TEXTUAL =
  '📍 Antes de cobrarte necesitamos confirmar que llegamos a tu zona.\n' +
  'Escribime tu dirección con *ciudad, barrio, calle y una referencia*.';

export const MENSAJE_UBICACION_NO_PROCESABLE =
  'Recibí tu ubicación 🙏 Por ahora no puedo procesarla automáticamente. Contame qué estás buscando o escribí *catálogo*.';

export const MENSAJE_DIRECCION_AMBIGUA =
  'Para ubicarte bien necesito un poco más de detalle 🙏 Escribime *ciudad, barrio, calle y una referencia* — o compartí tu ubicación con el clip 📎.';

export const MENSAJE_COBERTURA_CANCELADA =
  'Sin problema 👍 dejamos el pedido en pausa. Cuando quieras retomar, escribí *pagar*.';

export const MENSAJE_INTENTO_VENCIDO =
  'Ese intento de compra venció ⏳ Escribí *pagar* y lo retomamos desde tu carrito.';

export const MENSAJE_RESUME_EN_CURSO =
  'Estamos preparando tu pedido 🙌 En un momento te paso los datos para el pago.';

export const MENSAJE_UBICACION_FALLO =
  'No pude registrar tu ubicación recién 🙏 Probá mandarla de nuevo en un momento.';

/** SHIPPING-CHAT-3C: recompra con cotización obligatoria — la ubicación aprobada se reusa. */
export const MENSAJE_REQUOTE_EN_REVISION =
  'Ya tenemos tu ubicación ✅ Estamos confirmando el costo de envío de tu pedido: te avisamos enseguida para completar el pago.';

/** Mensaje de solicitud según canal: el botón nativo existe SOLO en WhatsApp (review). */
export function solicitudPara(cfg: ResolvedCoverageConfig, channel?: MessageChannel | null): string {
  if (channel && channel !== 'whatsapp') return MENSAJE_SOLICITUD_UBICACION_TEXTUAL;
  return cfg.requestMessage;
}

/**
 * KILL-SWITCH-1: resuelve la config desde los DATOS CRUDOS de un snapshot leído dentro de una
 * transacción (`tx.get(config/checkout)`), para validar flag/activación de forma atómica con
 * las escrituras que gatea. Misma validación fail-closed que coverageSettings.
 */
export function coverageSettingsDeSnapshot(data: unknown): ResolvedCoverageConfig {
  return coverageSettings({ bankAccounts: [], sellers: [], coverage: (data as { coverage?: unknown } | undefined)?.coverage } as unknown as CheckoutConfig);
}

const configRefDe = (tenantId: string) => db().doc(`tenants/${tenantId}/config/checkout`);

/**
 * Valida la config cruda del tenant. Cualquier cosa rara ⇒ `enabled:false` (fail-safe).
 * HARDEN-1: `enabled: true` SIN un activationId VÁLIDO también ⇒ OFF (contrato fail-closed;
 * la regla vive en @vpw/shared/coverageActivation — misma validación en backend y panel).
 */
export function coverageSettings(config: CheckoutConfig | null | undefined): ResolvedCoverageConfig {
  const off: ResolvedCoverageConfig = { enabled: false, activationId: null, expiryHours: EXPIRY_DEFAULT_HOURS, requestMessage: MENSAJE_SOLICITUD_UBICACION, rejectedMessage: null };
  const raw = config?.coverage;
  const act = coverageActivationOf(raw);
  if (!act.enabled || !act.activationId) return off;
  const hours = (raw as { expiryHours?: unknown }).expiryHours;
  const expiryHours = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= EXPIRY_MAX_HOURS ? hours : EXPIRY_DEFAULT_HOURS;
  const msg = (raw as { requestMessage?: unknown }).requestMessage;
  const rej = (raw as { rejectedMessage?: unknown }).rejectedMessage;
  const requestMessage = typeof msg === 'string' && msg.trim() !== '' ? msg.trim().slice(0, MESSAGE_MAX) : MENSAJE_SOLICITUD_UBICACION;
  const rejectedMessage = typeof rej === 'string' && rej.trim() !== '' ? rej.trim().slice(0, MESSAGE_MAX) : null;
  return { enabled: true, activationId: act.activationId, expiryHours, requestMessage, rejectedMessage };
}

// ---------------------------------------------------------------------------
// Huellas (puras)
// ---------------------------------------------------------------------------

const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const normalizarTexto = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Huella de la UBICACIÓN (la aprobación vale para esta huella). Coordenadas redondeadas a
 * 4 decimales (~11 m: la misma casa da la misma huella aunque el GPS baile). Texto normalizado.
 */
export function locationFingerprintOf(loc: Pick<CoverageLocation, 'coordinates' | 'addressText'>): string {
  if (loc.coordinates) {
    const lat = loc.coordinates.lat.toFixed(4);
    const lng = loc.coordinates.lng.toFixed(4);
    return `geo:${sha16(`${lat},${lng}`)}`;
  }
  return `txt:${sha16(normalizarTexto(loc.addressText ?? ''))}`;
}

/** Huella del carrito (contexto/idempotencia del checkout — NO condiciona la aprobación). */
export function cartFingerprintOf(cart: Cart): string {
  const pares = cart.items.map((i) => `${i.productId}x${i.quantity}`).sort().join('|');
  return `cart:${sha16(pares)}`;
}

/**
 * SHIPPING-CHAT-3C — Huella FINANCIERA del carrito (versionada `cart2:`): incluye productId,
 * quantity, unitPrice y el subtotal global recalculado — a diferencia de `cart:` (v1), garantiza
 * que el total mostrado al cotizar es el total que se ordenará. PURA y fail-closed: cualquier
 * inconsistencia ⇒ null (jamás se cotiza sobre un carrito inválido).
 * El nombre y la imageUrl NUNCA son autoridad financiera (no participan de la huella).
 * Valida: enteros seguros no negativos, quantity > 0, subtotal === Σ price×quantity, sin
 * duplicados inconsistentes (mismo producto con precios distintos), sin overflow.
 */
export function shippingCartFingerprintOf(cart: { items: Array<{ productId: string; price: number; quantity: number }>; subtotal: number }): string | null {
  if (!Array.isArray(cart.items) || cart.items.length === 0) return null;
  const precioPorProducto = new Map<string, number>();
  let suma = 0;
  const lineas: string[] = [];
  for (const i of cart.items) {
    if (typeof i.productId !== 'string' || i.productId === '') return null;
    if (!Number.isSafeInteger(i.quantity) || i.quantity <= 0) return null;
    if (!Number.isSafeInteger(i.price) || i.price < 0) return null;
    const previo = precioPorProducto.get(i.productId);
    if (previo !== undefined && previo !== i.price) return null; // duplicado inconsistente
    precioPorProducto.set(i.productId, i.price);
    const linea = i.price * i.quantity;
    if (!Number.isSafeInteger(linea)) return null; // overflow por línea
    suma += linea;
    if (!Number.isSafeInteger(suma)) return null; // overflow acumulado
    lineas.push(`${i.productId}x${i.quantity}@${i.price}`);
  }
  if (!Number.isSafeInteger(cart.subtotal) || cart.subtotal !== suma) return null; // subtotal exacto
  return `cart2:${sha16(lineas.sort().join('|') + '|s:' + suma)}`;
}

export const cartSnapshotOf = (cart: Cart | { items: Array<{ productId: string; name: string; price: number; quantity: number }>; subtotal: number }): CoverageRequest['cartSnapshot'] => ({
  // Precios públicos del carrito. SIN costos privados (ADR-0008) y sin imageUrl (ruido).
  items: cart.items.map((i) => ({ productId: i.productId, name: i.name, price: i.price, quantity: i.quantity })),
  subtotal: cart.subtotal,
});

// ---------------------------------------------------------------------------
// Clasificación del texto durante awaiting_location (pura — para tests)
// ---------------------------------------------------------------------------

export type ClasificacionTextoEspera = 'direccion' | 'ambiguo' | 'cancelacion' | 'como_compartir' | 'otro';

/**
 * ¿Qué es este texto mientras esperamos la ubicación? AUTOCONTENIDA (sin imports del engine):
 * las exclusiones ('otro') dejan que el flujo normal atienda el turno — producto, carrito,
 * pagar, vendedor, reclamos, comprobantes y preguntas siguen su camino de siempre.
 */
export function clasificarTextoEnEspera(text: string): ClasificacionTextoEspera {
  const n = normalizarTexto(text);
  if (n === '') return 'ambiguo';

  // Cancelación / negarse a compartir la ubicación (incluye diferir el pago: "no quiero pagar").
  if (/\b(cancelar|cancelalo|dejalo|dejemoslo|mejor no|olvidalo|ahora no|mas tarde|no quiero (compartir|pasar|mandar|dar|seguir|continuar|pagar)|no voy a pagar|no te (paso|comparto|mando)|despues (te|lo) (paso|mando))\b/.test(n)) {
    return 'cancelacion';
  }
  // Pregunta sobre CÓMO compartir la ubicación.
  if (/\b(como|donde)\b/.test(n) && /\b(ubicacion|comparto|compartir|mando|mandar|boton|clip)\b/.test(n)) return 'como_compartir';
  // Consulta de cobertura ("¿llegan a X?") mientras esperamos la ubicación: la mejor respuesta
  // ES re-explicar cómo compartirla (el equipo confirma la zona con la ubicación real).
  if (esConsultaCobertura(text)) return 'como_compartir';

  // Señal POSITIVA de dirección — el default ya NO es dirección (review: "ya te la mando",
  // "muchas gracias" o cualquier charla ≥12 chars se registraban como dirección). Se exige
  // léxico de calle/casa y/o números; con señal fuerte, gana incluso sobre las exclusiones
  // ("Villa Elisa calle Tte Rojas 123 me ubicas?" ES una dirección aunque pregunte).
  const lexico = (n.match(/\b(calle|avda|avd|av|avenida|ruta|km|barrio|ciudad|esquina|casi|edificio|edif|depto|dpto|piso|casa|porton|manzana|mz|lote|villa|frente|referencia|domicilio|direccion)\b/g) ?? []).length;
  const tieneDigitos = /\d/.test(n);
  const palabrasConLetras = n.split(' ').filter((w) => /[a-zñ]{2,}/.test(w)).length;
  if (n.length >= 12 && palabrasConLetras >= 2 && ((tieneDigitos && lexico >= 1) || lexico >= 2)) return 'direccion';

  // Exclusiones → flujo normal ('otro').
  if (/\b(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches)\b/.test(n) && n.length <= 30) return 'otro';
  if (/\b(vendedor|vendedora|asesor|asesora|humano|persona|encargado|duen[oa])\b/.test(n)) return 'otro'; // HANDOFF-2 (ya intercepta antes)
  if (/\b(pagar|pago|checkout|finalizar|comprar|cobrar|terminar (compra|pedido))\b/.test(n)) return 'otro'; // re-pedido de pagar → gate
  if (/\b(carrito|catalogo|productos?|perfumes?|promo(cion(es)?)?|precio)\b/.test(n)) return 'otro';
  if (/\b(comprobante|captura|recibo|transferencia|deposito|factura)\b/.test(n)) return 'otro';
  if (/\b(no (me )?(lo |la )?agregaste|te equivocaste|no era ese|yo (queria|pedi)|te pedi)\b/.test(n)) return 'otro'; // reclamos
  if (/[?¿]/.test(text)) return 'otro'; // preguntas (producto, ficha, lo que sea) → flujo normal

  return 'ambiguo';
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

const requestPath = (tenantId: string, requestId: string) => `tenants/${tenantId}/coverageRequests/${requestId}`;

const TERMINALES: readonly CoverageStatus[] = ['coverage_rejected', 'coverage_expired', 'coverage_cancelled'];
const PURGE_DAYS = 30; // retención máxima futura de coordenadas exactas (el job llega después de 1B)

export const purgeAtFrom = (now: Timestamp, req: Pick<CoverageRequest, 'location'>): Timestamp | null =>
  req.location?.coordinates ? Timestamp.fromMillis(now.toMillis() + PURGE_DAYS * 24 * 60 * 60 * 1000) : null;

const ptrOf = (req: Pick<CoverageRequest, 'id' | 'status' | 'locationFingerprint' | 'createdAt'>, now: Timestamp): CoverageSessionPointer => ({
  requestId: req.id,
  status: req.status,
  locationFingerprint: req.locationFingerprint ?? null,
  createdAt: req.createdAt,
  updatedAt: now,
});

export interface CoverageGateResult {
  reply: string;
  /** true ⇒ el turno debe intentar el location_request_message interactivo (con fallback textual). */
  locationRequest?: boolean;
  /** Puntero para que el tail del engine lo persista (tri-estado: undefined = conservar). */
  coverage?: CoverageSessionPointer | null;
  /**
   * KILL-SWITCH-1: activación bajo la que se generó este reply de cobertura. process.ts re-lee el
   * flag JUSTO antes del envío físico y NO manda el mensaje si el flujo se apagó/rotó en el medio
   * (un apagado de emergencia frena también la solicitud de ubicación y la promesa de revisión).
   */
  coverageActivationId?: string | null;
}

/**
 * KILL-SWITCH-1: ¿el flujo sigue vigente para ESTA activación? Lectura FRESCA de config, para
 * gatear el envío físico de un reply de cobertura inmediatamente antes de llamar a Meta.
 */
export async function coberturaVigente(tenantId: string, activationId: string | null): Promise<boolean> {
  if (activationId == null) return true; // reply no-cobertura (o neutral): no se gatea
  const act = coverageSettingsDeSnapshot((await configRefDe(tenantId).get()).data());
  return act.enabled && act.activationId === activationId;
}

/**
 * ETAPA C — Gate del checkout. null ⇒ el checkout sigue su camino normal (flag off, o
 * aprobación VIGENTE para la ubicación). Si intercepta: crea/reusa el request en una
 * transacción sobre la sesión (dos "pagar" concurrentes → un solo request) y pide la ubicación.
 * KILL-SWITCH-1: el flag/activación se re-leen DENTRO de esa transacción — un apagado que
 * commitea antes del claim gana SIEMPRE: cero escrituras de cobertura y checkout tradicional.
 */
export async function gateCoberturaCheckout(
  tenantId: string,
  customerId: string,
  cart: Cart,
  opts: { messageId?: string | null; simulation?: boolean; channel?: MessageChannel; receivedVia?: string | null },
): Promise<CoverageGateResult | null> {
  const cfg = coverageSettings(await getCheckoutConfig(tenantId));
  if (!cfg.enabled) return null; // fast-path (la autoridad es la RE-lectura en la transacción)

  // Simulación (chat de prueba / test cases): mismo texto, CERO efectos operativos.
  if (opts.simulation === true) {
    return { reply: solicitudPara(cfg, opts.channel), locationRequest: true };
  }

  await coverageHold(tenantId, 'gate_pre_tx'); // solo-emulador: test del kill-switch

  const sessionRef = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  const out = await db().runTransaction(async (tx) => {
    const cfgSnapTx = await tx.get(configRefDe(tenantId));
    const cfgTx = coverageSettingsDeSnapshot(cfgSnapTx.data());
    if (!cfgTx.enabled) return { kind: 'off' as const };
    const actId = cfgTx.activationId;
    // SHIPPING-CHAT-3C: política de cotización del MISMO snapshot (off ⇒ comportamiento legado).
    const policyTx = shippingQuotePolicyOf((cfgSnapTx.data() as { coverage?: unknown } | undefined)?.coverage);
    const ses = await tx.get(sessionRef);
    const ctxSes = (ses.data() as Session | undefined)?.context;
    // 1D: hay una reanudación EN CURSO (el worker está creando la orden): un "pagar" concurrente
    // no dispara OTRO checkout — se le pide un momento al cliente.
    if (ctxSes?.coverageResumeInProgress) return { kind: 'resuming' as const, activationId: actId };
    const ptr = ctxSes?.coverage ?? null;
    if (ptr) {
      const reqSnap = await tx.get(db().doc(requestPath(tenantId, ptr.requestId)));
      const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
      if (req && req.customerId === customerId && !TERMINALES.includes(req.status)) {
        const vencido = req.expiresAt.toMillis() <= now.toMillis();
        // HARDEN-1: un request de una activación ANTERIOR es indecidible (las callables lo
        // rechazan) — se expira acá mismo para que el checkout no quede congelado, y se crea
        // uno nuevo bajo la activación vigente. El dato histórico queda, jamás se borra.
        const activacionVigente = (req.activationId ?? null) === cfgTx.activationId;
        if (!vencido && activacionVigente) {
          if (req.status === 'awaiting_location') return { kind: 'ask' as const, ptr: ptrOf(req, now), activationId: actId };
          if (req.status === 'pending_coverage_review') return { kind: 'pending' as const, ptr: ptrOf(req, now), activationId: actId };
          // coverage_approved con reanudación AÚN NO COMPLETADA (1D): un "pagar" en la ventana
          // decisión→worker NO dispara el checkout normal — habría DOS órdenes (review).
          const resume = req.resume?.status;
          if (resume === 'pending' || resume === 'processing' || resume === 'held_by_seller') {
            return { kind: 'resuming' as const, activationId: actId };
          }
          if (policyTx.status !== 'off') {
            // SHIPPING-CHAT-3C (H): con cotización obligatoria (o config inválida — fail-closed):
            // 1) Un pipeline anterior NO terminal (send_failed/send_unknown) BLOQUEA el checkout
            //    nuevo. JAMÁS se cancela automáticamente: debe quedar terminal o ser reconciliado
            //    explícitamente. El cliente espera; el equipo resuelve por el panel.
            if (resume === 'send_failed' || resume === 'send_unknown') {
              return { kind: 'resuming' as const, activationId: actId };
            }
            // 2) Pipeline terminal (done/cancelled): una compra NUEVA jamás reusa el request
            //    aprobado para otro carrito — se crea un REQUEST NUEVO reusando la ubicación
            //    aprobada vigente (sin volver a pedírsela al cliente), directo a revisión para
            //    que el vendedor cotice el envío del carrito actual.
            const id = newCoverageRequestId();
            const fp2 = shippingCartFingerprintOf(cart);
            const nuevo: CoverageRequest = {
              id,
              tenantId,
              customerId,
              channel: opts.channel ?? req.channel ?? 'whatsapp',
              receivedVia: opts.receivedVia ?? req.receivedVia ?? null,
              activationId: cfgTx.activationId,
              status: 'pending_coverage_review',
              location: req.location,
              locationFingerprint: req.locationFingerprint,
              sourceMessageId: opts.messageId ?? null,
              cartSnapshot: cartSnapshotOf(cart),
              cartFingerprint: fp2 ?? cartFingerprintOf(cart),
              checkoutAttemptId: null,
              sellerUid: req.sellerUid ?? null,
              sellerName: req.sellerName ?? null,
              decision: null,
              resume: null,
              createdAt: now,
              updatedAt: now,
              expiresAt: Timestamp.fromMillis(now.toMillis() + cfgTx.expiryHours * 60 * 60 * 1000),
              coordinatesPurgeAt: null,
            };
            tx.create(db().doc(requestPath(tenantId, id)), nuevo);
            const ptrNuevo = ptrOf(nuevo, now);
            tx.set(sessionRef, { context: { coverage: ptrNuevo }, updatedAt: now }, { merge: true });
            // Campana ATÓMICA con el request (review adversarial 3C): un aviso post-tx best-effort
            // podía perderse ante un crash y nadie lo reintentaba — el request quedaba huérfano en
            // revisión sin que el equipo lo viera. requestId es nuevo por corrida ⇒ create sin colisión.
            const notifId = `covrequote-${customerId}-${id}`;
            tx.create(db().collection(paths.notifications(tenantId)).doc(notifId), {
              id: notifId,
              tenantId,
              category: 'handoff',
              type: 'handoff_coverage_review',
              title: '📍 Un cliente espera confirmación de cobertura',
              body: `El cliente …${customerId.slice(-4)} quiere volver a comprar con su ubicación ya aprobada. Cotizá el envío del carrito actual desde Conversaciones (el bot sigue activo).`,
              dedupeKey: notifId,
              customerId,
              ...(req.sellerUid ? { targetUid: req.sellerUid } : {}),
              read: false,
              readAt: null,
              createdAt: now,
            });
            return {
              kind: 'requote' as const,
              ptr: ptrNuevo,
              activationId: actId,
              requestId: id,
            };
          }
          // coverage_approved VIGENTE (política off — legado): la aprobación vale para la
          // ubicación aunque el carrito haya cambiado → el checkout continúa por el camino normal.
          return { kind: 'approved' as const };
        }
        tx.update(reqSnap.ref, { status: 'coverage_expired', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      }
    }
    // Crear request nuevo (awaiting_location) + puntero en la sesión, atómico.
    const id = newCoverageRequestId();
    const nuevo: CoverageRequest = {
      id,
      tenantId,
      customerId,
      channel: opts.channel ?? 'whatsapp',
      receivedVia: opts.receivedVia ?? null,
      activationId: cfgTx.activationId,
      status: 'awaiting_location',
      location: null,
      locationFingerprint: null,
      sourceMessageId: opts.messageId ?? null,
      cartSnapshot: cartSnapshotOf(cart),
      cartFingerprint: cartFingerprintOf(cart),
      checkoutAttemptId: null,
      sellerUid: null,
      sellerName: null,
      decision: null,
      resume: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + cfgTx.expiryHours * 60 * 60 * 1000),
      coordinatesPurgeAt: null,
    };
    tx.create(db().doc(requestPath(tenantId, id)), nuevo);
    const ptrNew = ptrOf(nuevo, now);
    tx.set(sessionRef, { context: { coverage: ptrNew }, updatedAt: now }, { merge: true });
    return { kind: 'ask' as const, ptr: ptrNew, activationId: actId };
  });

  // Kill-switch ganó DENTRO de la transacción: cero escrituras → checkout tradicional.
  if (out.kind === 'off') return null;
  if (out.kind === 'approved') return null;
  const act = out.activationId;
  if (out.kind === 'resuming') return { reply: MENSAJE_RESUME_EN_CURSO, coverageActivationId: act };
  if (out.kind === 'requote') {
    // SHIPPING-CHAT-3C: request nuevo + campana YA persistidos (atómicos, en la tx). SIN takeover:
    // tomar el chat dentro de este turno haría que el tail del engine descarte la respuesta al
    // cliente ("turno en vuelo descartado"). La cotización llega por el flujo canónico del panel,
    // que no requiere takeover; el vendedor puede tomar el chat manualmente si lo necesita.
    logger.info('Cobertura: recompra → request nuevo en revisión con ubicación reusada', { tenantId, customer: maskPhone(customerId), requestId: out.requestId });
    return { reply: MENSAJE_REQUOTE_EN_REVISION, coverage: out.ptr, coverageActivationId: act };
  }
  if (out.kind === 'pending') return { reply: MENSAJE_UBICACION_EN_REVISION, coverage: out.ptr, coverageActivationId: act };
  logger.info('Cobertura: checkout en espera de ubicación', { tenantId, customer: `…${customerId.slice(-4)}`, requestId: out.ptr.requestId });
  return { reply: solicitudPara(cfg, opts.channel), locationRequest: true, coverage: out.ptr, coverageActivationId: act };
}

// ---------------------------------------------------------------------------
// Registro de ubicación (nativa o dirección escrita) — transaccional
// ---------------------------------------------------------------------------

type RegistroResultado =
  | { kind: 'ok'; requestId: string; primeraVez: boolean; humanTakeover: boolean; handoffReason: string | null; ptr: CoverageSessionPointer; sellerUid: string | null; sellerName: string | null }
  | { kind: 'no_active' }
  | { kind: 'approved_activo' }
  | { kind: 'expired' }
  | { kind: 'off' };

/**
 * KILL-SWITCH-1: el flag/activación se leen DENTRO de esta transacción (no se confía en ninguna
 * lectura previa del caller). Con OFF que commiteó antes: CERO escrituras — ni dirección, ni
 * coordenadas, ni fingerprint, ni asignación de seller.
 */
async function registrarUbicacion(
  tenantId: string,
  customerId: string,
  location: CoverageLocation,
  wamid: string | null,
): Promise<RegistroResultado> {
  await coverageHold(tenantId, 'ubicacion_pre_tx'); // solo-emulador: test del kill-switch
  const sessionRef = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const act = coverageSettingsDeSnapshot((await tx.get(configRefDe(tenantId))).data());
    if (!act.enabled) return { kind: 'off' as const };
    const ses = await tx.get(sessionRef);
    const ctx = (ses.data() as Session | undefined)?.context;
    const ptr = ctx?.coverage ?? null;
    if (!ptr) return { kind: 'no_active' as const };
    const reqSnap = await tx.get(db().doc(requestPath(tenantId, ptr.requestId)));
    const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
    if (!req || req.customerId !== customerId || TERMINALES.includes(req.status)) return { kind: 'no_active' as const };
    // HARDEN-1: request de una activación ANTERIOR (incluso aprobado) — nadie puede decidirlo
    // ni reanudarlo: se expira acá y el cliente retoma con *pagar* bajo la activación vigente.
    if ((req.activationId ?? null) !== act.activationId) {
      tx.update(reqSnap.ref, { status: 'coverage_expired', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      tx.set(sessionRef, { context: { coverage: null }, updatedAt: now }, { merge: true });
      return { kind: 'expired' as const };
    }
    if (req.status === 'coverage_approved') return { kind: 'approved_activo' as const }; // aprobado: no se re-abre solo
    if (req.expiresAt.toMillis() <= now.toMillis()) {
      tx.update(reqSnap.ref, { status: 'coverage_expired', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      tx.set(sessionRef, { context: { coverage: null }, updatedAt: now }, { merge: true });
      return { kind: 'expired' as const };
    }
    // 1C: asignación del request al SELLER del cliente (uid de Auth, server-controlled) — las
    // rules le abren la lectura/decisión SOLO de sus requests; la campana lo apunta (targetUid).
    const custSnap = await tx.get(db().doc(paths.customer(tenantId, customerId)));
    const cust = custSnap.data() as { assignedSellerId?: string | null; assignedSellerName?: string | null } | undefined;
    const sellerUid = cust?.assignedSellerId ?? req.sellerUid ?? null;
    const sellerNameAsignado = cust?.assignedSellerName ?? req.sellerName ?? null;
    const primeraVez = req.status === 'awaiting_location';
    const locationFingerprint = locationFingerprintOf(location);
    tx.update(reqSnap.ref, {
      location,
      locationFingerprint, // una ubicación nueva antes de la decisión INVALIDA la huella anterior
      status: 'pending_coverage_review',
      sourceMessageId: wamid ?? req.sourceMessageId ?? null,
      sellerUid,
      sellerName: sellerNameAsignado,
      updatedAt: now,
    });
    const ptrNew: CoverageSessionPointer = { ...ptrOf({ ...req, status: 'pending_coverage_review', locationFingerprint }, now) };
    tx.set(sessionRef, { context: { coverage: ptrNew }, updatedAt: now }, { merge: true });
    return {
      kind: 'ok' as const,
      requestId: req.id,
      primeraVez,
      humanTakeover: ctx?.humanTakeover === true,
      handoffReason: ctx?.handoffReason ?? null,
      ptr: ptrNew,
      sellerUid,
      sellerName: sellerNameAsignado,
    };
  });
}

/** Vendedor para el handoff: el primero activo de la config, sin placeholders. */
function vendedorParaCobertura(config: CheckoutConfig): string | null {
  const s = pickSeller({ ...config, sellers: config.sellers.filter((v) => !/REEMPLAZAR/i.test(v.name)) });
  return s?.name ?? null;
}

/**
 * Post-persistencia: handoff canónico `coverage_review` (sourceId = requestId — NO el wamid) +
 * notificación `handoff_coverage_review` idempotente POR WAMID + respuesta al cliente.
 * La confirmación al cliente sale SOLO si la persistencia ya quedó firme.
 * KILL-SWITCH-1: el takeover se toma con un GUARD dentro de la transacción del handoff — flag
 * vigente + misma activación + request todavía pendiente del MISMO tenant/cliente. Si el flag
 * cambió después de persistir la ubicación, NO se toma el chat NI se notifica.
 */
async function derivarARevision(
  tenantId: string,
  customerId: string,
  registro: Extract<RegistroResultado, { kind: 'ok' }>,
  wamid: string | null,
): Promise<{ reply: string; takeover: boolean }> {
  await coverageHold(tenantId, 'pre_handoff'); // solo-emulador: test del kill-switch
  // Vendedor del handoff: el ASIGNADO al cliente (uid real, ya persistido en el request por la
  // transacción de registro); sin asignado, el primero activo de la config (solo display).
  const sellerName = registro.sellerName ?? vendedorParaCobertura(await getCheckoutConfig(tenantId));
  const hr = await executeHandoff(tenantId, customerId, {
    reason: 'coverage_review',
    sellerName: sellerName ?? undefined,
    sellerUid: registro.sellerUid ?? undefined,
    sourceId: registro.requestId,
    createSessionIfMissing: false,
    guard: async (tx) => {
      const [cfgSnap, reqSnap] = await Promise.all([
        tx.get(configRefDe(tenantId)),
        tx.get(db().doc(requestPath(tenantId, registro.requestId))),
      ]);
      const act = coverageSettingsDeSnapshot(cfgSnap.data());
      const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
      return (
        act.enabled &&
        req !== null &&
        (req.activationId ?? null) === act.activationId &&
        req.status === 'pending_coverage_review' &&
        req.tenantId === tenantId &&
        req.customerId === customerId
      );
    },
  });
  if (hr.blocked) {
    // El flujo se apagó (o el request dejó de estar pendiente) entre la persistencia y el
    // handoff: sin takeover, sin campana, sin promesa de revisión — respuesta honesta neutra.
    logger.info('Cobertura: handoff bloqueado por kill-switch tras registrar la ubicación', { tenantId, customer: `…${customerId.slice(-4)}`, requestId: registro.requestId });
    return { reply: registro.humanTakeover ? '' : MENSAJE_UBICACION_NO_PROCESABLE, takeover: false };
  }
  // Aviso a la campana: SIEMPRE tras persistir (salvo bloqueo), deduplicado por wamid (un webhook
  // repetido no duplica; una ubicación NUEVA con wamid nuevo sí avisa — el equipo ve la
  // actualización). targetUid (server-controlled) le abre la campana al SELLER asignado (1C).
  await notifyHandoffRequested(tenantId, customerId, sellerName, wamid, 'coverage_review', registro.sellerUid ?? null);
  if (hr.ok && !hr.already) {
    logger.info('Cobertura: ubicación registrada → revisión humana', { tenantId, customer: `…${customerId.slice(-4)}`, requestId: registro.requestId });
    return { reply: MENSAJE_UBICACION_RECIBIDA, takeover: true };
  }
  if (hr.already && registro.handoffReason === 'coverage_review') {
    // Ya estaba en revisión de cobertura (actualización de ubicación / carrera del webhook).
    return { reply: registro.primeraVez ? MENSAJE_UBICACION_RECIBIDA : MENSAJE_UBICACION_ACTUALIZADA, takeover: true };
  }
  if (hr.already && registro.handoffReason === null) {
    // Carrera nativa+texto casi simultáneas: la razón leída en la tx quedó stale — si el
    // takeover FRESCO apunta a ESTE request, es nuestro propio flujo: confirmar igual (review).
    const fresh = (await db().doc(paths.session(tenantId, customerId)).get()).data() as Session | undefined;
    if (fresh?.context?.handoffReason === 'coverage_review' && fresh?.context?.handoffSourceId === registro.requestId) {
      return { reply: registro.primeraVez ? MENSAJE_UBICACION_RECIBIDA : MENSAJE_UBICACION_ACTUALIZADA, takeover: true };
    }
  }
  if (hr.already) {
    // Takeover VIGENTE de otra razón (vendedor manual / pedido de humano / comprobante): no se
    // pisa ni se promete un pase — el request quedó pendiente y visible; el bot no responde.
    logger.info('Cobertura: ubicación registrada con takeover ajeno vigente (sin respuesta del bot)', { tenantId, customer: `…${customerId.slice(-4)}`, requestId: registro.requestId });
    return { reply: '', takeover: true };
  }
  // El handoff no persistió (borde: sesión desaparecida). El request quedó pendiente y el aviso
  // salió: la revisión ocurre igual por el panel — se confirma la recepción sin prometer pase.
  return { reply: MENSAJE_UBICACION_RECIBIDA, takeover: false };
}

// ---------------------------------------------------------------------------
// ETAPA D — Ubicación NATIVA (llega desde process.ts, nunca pasa por la IA)
// ---------------------------------------------------------------------------

export interface UbicacionEntranteInput {
  tenantId: string;
  from: string;
  location: InboundLocation;
  messageId: string | null;
  receivedByPhoneNumberId: string | null;
  channel: MessageChannel;
}

/**
 * Procesa una ubicación nativa. El historial SOLO recibe el placeholder `📍 Ubicación recibida`
 * (jamás coordenadas/dirección) y SOLO cuando el flujo está activo. Devuelve la respuesta a
 * entregar (puede ser '') + `coverageActivationId` (KILL-SWITCH-1: process.ts re-lee el flag
 * antes de mandarla) + `inerte` (OFF-INERTE: con cobertura apagada la ubicación es INERTE —
 * ni placeholder, ni reply, ni registro, ni handoff, ni uso; el inbox conserva solo la redacción).
 */
export async function procesarUbicacionEntrante(input: UbicacionEntranteInput): Promise<{ reply: string; coverageActivationId?: string | null; inerte?: boolean }> {
  const { tenantId } = input;
  const customerId = input.from.replace(/[^0-9]/g, '');
  if (!customerId) return { reply: '', inerte: true };
  const now = Timestamp.now();

  // OFF-INERTE (H1): el gate del flag va ANTES de cualquier persistencia específica de ubicación.
  // Con cobertura ausente/off/inválida, la ubicación nativa conserva EXACTAMENTE el comportamiento
  // heredado (pre-Coverage): se ignora en silencio — ni placeholder, ni registro, ni handoff, ni
  // reply, ni uso. process.ts solo conserva la redacción del inbox (payload.location=null).
  const cfg = coverageSettings(await getCheckoutConfig(tenantId));
  if (!cfg.enabled) return { reply: '', inerte: true };

  const ses = (await db().doc(paths.session(tenantId, customerId)).get()).data() as Session | undefined;
  const humanTakeover = ses?.context?.humanTakeover === true;

  let reply = '';
  let enTakeover = humanTakeover;
  // KILL-SWITCH-1: solo las respuestas que PROMETEN revisión/cobertura se gatean antes del envío
  // (RECIBIDA, ZONA_YA_CONFIRMADA). Las neutrales (vencido/sin pedido) son honestas → no se etiquetan.
  let coverageActivationId: string | null = null;
  const location: CoverageLocation = {
    source: 'whatsapp_location',
    addressText: input.location.address,
    name: input.location.name,
    coordinates: { lat: input.location.latitude, lng: input.location.longitude },
  };
  let registro: RegistroResultado;
  try {
    registro = await registrarUbicacion(tenantId, customerId, location, input.messageId);
  } catch (e) {
    // G.10: la persistencia falló ANTES de cualquier escritura de historial — mensaje temporal
    // honesto, sin placeholder (nada quedó registrado).
    logger.error('Cobertura: no se pudo registrar la ubicación', e, { tenantId, customer: `…${customerId.slice(-4)}` });
    if (!humanTakeover) {
      await appendMessage(tenantId, customerId, { direction: 'out', author: 'bot', text: MENSAJE_UBICACION_FALLO, now: Timestamp.now(), state: ses?.state ?? null, humanTakeover, countUnread: false, channel: input.channel, receivedVia: input.receivedByPhoneNumberId ?? null });
    }
    return { reply: humanTakeover ? '' : MENSAJE_UBICACION_FALLO, coverageActivationId: null };
  }

  // OFF-INERTE (carrera): el flag se apagó ENTRE la lectura inicial y la transacción de registro.
  // registrarUbicacion no persistió nada ⇒ la ubicación queda INERTE: sin placeholder ni reply.
  if (registro.kind === 'off') return { reply: '', inerte: true };

  // Flag confirmado ON dentro de la transacción de registro → recién ACÁ el placeholder redactado
  // (jamás coordenadas/dirección) entra al historial.
  await appendMessage(tenantId, customerId, {
    direction: 'in',
    author: 'customer',
    text: '📍 Ubicación recibida',
    now,
    state: ses?.state ?? null,
    humanTakeover,
    countUnread: humanTakeover,
    channel: input.channel,
    receivedVia: input.receivedByPhoneNumberId ?? null,
  });

  if (registro.kind === 'ok') {
    const r = await derivarARevision(tenantId, customerId, registro, input.messageId);
    reply = r.reply;
    enTakeover = enTakeover || r.takeover;
    // La respuesta CONFIRMA/PROMETE revisión (con o sin takeover — el borde "sesión desaparecida"
    // devuelve la promesa sin takeover): siempre se etiqueta para gatearla antes de Meta.
    if (reply.trim()) coverageActivationId = cfg.activationId;
  } else if (registro.kind === 'expired') {
    reply = humanTakeover ? '' : MENSAJE_INTENTO_VENCIDO;
  } else if (registro.kind === 'approved_activo') {
    reply = humanTakeover ? '' : MENSAJE_ZONA_YA_CONFIRMADA;
    coverageActivationId = cfg.activationId; // referencia cobertura confirmada → gatear
  } else {
    reply = humanTakeover ? '' : MENSAJE_UBICACION_SIN_PEDIDO;
  }

  if (reply.trim()) {
    await appendMessage(tenantId, customerId, {
      direction: 'out',
      author: 'bot',
      text: reply,
      now: Timestamp.now(),
      state: ses?.state ?? null,
      humanTakeover: enTakeover,
      countUnread: false,
      channel: input.channel,
      receivedVia: input.receivedByPhoneNumberId ?? null,
    });
  }
  return { reply, coverageActivationId };
}

// ---------------------------------------------------------------------------
// ETAPA E — Dirección ESCRITA durante awaiting_location (la llama el engine)
// ---------------------------------------------------------------------------

export interface TurnoEsperaResultado {
  /** true ⇒ el turno terminó con takeover persistido: el engine debe retornar SIN tocar la sesión. */
  takeover: boolean;
  reply: string;
  /** Puntero para el tail del engine (solo caminos sin takeover). */
  coverage?: CoverageSessionPointer | null;
  /** true ⇒ re-intentar el botón nativo (la respuesta vuelve a pedir la ubicación). */
  locationRequest?: boolean;
  /** KILL-SWITCH-1: activación del reply — process.ts re-lee el flag antes del envío físico. */
  coverageActivationId?: string | null;
}

/**
 * Maneja un turno de texto con request `awaiting_location`. Devuelve null si el flag está off o
 * el request ya no existe/aplica (el turno sigue su flujo normal y el puntero se limpia).
 */
export async function manejarTurnoEnEsperaUbicacion(
  tenantId: string,
  customerId: string,
  text: string,
  clasificacion: Exclude<ClasificacionTextoEspera, 'otro'>,
  opts: { messageId?: string | null; simulation?: boolean; channel?: MessageChannel },
): Promise<TurnoEsperaResultado | null> {
  const cfg = coverageSettings(await getCheckoutConfig(tenantId));
  if (!cfg.enabled) return null;
  const ask = solicitudPara(cfg, opts.channel);
  const act = cfg.activationId; // etiqueta para el gateo del envío en process.ts

  if (opts.simulation === true) {
    // Simuladores: representar el texto sin efectos operativos.
    const reply =
      clasificacion === 'direccion' ? MENSAJE_UBICACION_RECIBIDA
      : clasificacion === 'cancelacion' ? MENSAJE_COBERTURA_CANCELADA
      : clasificacion === 'como_compartir' ? ask
      : MENSAJE_DIRECCION_AMBIGUA;
    return { takeover: false, reply };
  }

  try {
    if (clasificacion === 'como_compartir') return { takeover: false, reply: ask, locationRequest: true, coverageActivationId: act };
    if (clasificacion === 'ambiguo') return { takeover: false, reply: MENSAJE_DIRECCION_AMBIGUA, coverageActivationId: act };

    if (clasificacion === 'cancelacion') {
      const now = Timestamp.now();
      const cancelado = await db().runTransaction(async (tx) => {
        // KILL-SWITCH-1: el flag se re-lee EN esta transacción — un apagado que commiteó antes
        // gana: ni se marca coverage_cancelled ni sale mensaje (el flujo normal atiende el turno).
        const actTx = coverageSettingsDeSnapshot((await tx.get(configRefDe(tenantId))).data());
        if (!actTx.enabled) return false;
        const sesRef = db().doc(paths.session(tenantId, customerId));
        const ptr = ((await tx.get(sesRef)).data() as Session | undefined)?.context?.coverage ?? null;
        if (!ptr) return false;
        const reqSnap = await tx.get(db().doc(requestPath(tenantId, ptr.requestId)));
        const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
        if (!req || req.customerId !== customerId || TERMINALES.includes(req.status) || req.status === 'coverage_approved') return false;
        if ((req.activationId ?? null) !== actTx.activationId) return false; // request de otra activación
        tx.update(reqSnap.ref, { status: 'coverage_cancelled', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
        tx.set(sesRef, { context: { coverage: null }, updatedAt: now }, { merge: true });
        return true;
      });
      return cancelado ? { takeover: false, reply: MENSAJE_COBERTURA_CANCELADA, coverage: null, coverageActivationId: act } : null;
    }

    // 'direccion': saneada, con tope, registrada SIN pasar por la IA. El inbound ya se persistió
    // como placeholder (el engine lo reemplaza ANTES de escribir el historial).
    const addressText = text.replace(/\s+/g, ' ').trim().slice(0, 512);
    const location: CoverageLocation = { source: 'text', addressText, name: null, coordinates: null };
    const registro = await registrarUbicacion(tenantId, customerId, location, opts.messageId ?? null);
    if (registro.kind === 'off') return null; // kill-switch en la transacción: el flujo normal atiende
    if (registro.kind === 'expired') return { takeover: false, reply: MENSAJE_INTENTO_VENCIDO, coverage: null };
    if (registro.kind === 'approved_activo') return { takeover: false, reply: MENSAJE_ZONA_YA_CONFIRMADA, coverageActivationId: act };
    if (registro.kind === 'no_active') return null; // el flujo normal atiende el turno
    const r = await derivarARevision(tenantId, customerId, registro, opts.messageId ?? null);
    return { takeover: r.takeover, reply: r.reply, coverageActivationId: act, ...(r.takeover ? {} : { coverage: registro.ptr }) };
  } catch (e) {
    logger.error('Cobertura: no se pudo registrar la dirección', e, { tenantId, customer: `…${customerId.slice(-4)}` });
    return { takeover: false, reply: MENSAJE_UBICACION_FALLO };
  }
}

// ---------------------------------------------------------------------------
// 1C — Dirección escrita DURANTE la revisión (bot en takeover coverage_review)
// ---------------------------------------------------------------------------

/**
 * Gap 1C: con el takeover `coverage_review` vigente, una nueva dirección escrita del cliente
 * actualiza el request pendiente (misma transacción de registro: ubicación + fingerprint) SIN
 * respuesta del bot — el mensaje humano queda visible para el vendedor. Devuelve true si
 * actualizó (solo `pending_coverage_review` vigente; nunca reabre terminales/aprobados).
 */
export async function actualizarUbicacionEnRevision(
  tenantId: string,
  customerId: string,
  text: string,
  wamid: string | null,
): Promise<boolean> {
  try {
    const cfg = coverageSettings(await getCheckoutConfig(tenantId));
    if (!cfg.enabled) return false;
    const addressText = text.replace(/\s+/g, ' ').trim().slice(0, 512);
    const location: CoverageLocation = { source: 'text', addressText, name: null, coordinates: null };
    const registro = await registrarUbicacion(tenantId, customerId, location, wamid);
    if (registro.kind !== 'ok') return false;
    logger.info('Cobertura: dirección actualizada durante la revisión (bot en silencio)', { tenantId, customer: `…${customerId.slice(-4)}`, requestId: registro.requestId });
    return true;
  } catch (e) {
    logger.error('Cobertura: no se pudo actualizar la dirección en revisión', e, { tenantId, customer: `…${customerId.slice(-4)}` });
    return false;
  }
}
