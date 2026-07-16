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
import { newCoverageRequestId } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { getCheckoutConfig, pickSeller } from '../orders/checkoutConfig.js';
import { executeHandoff, notifyHandoffRequested } from './handoff.js';
import { esConsultaCobertura } from './coverageGuard.js';
import { appendMessage } from './messages.js';
import type { InboundLocation } from '../meta/parseWebhook.js';

// ---------------------------------------------------------------------------
// Config del tenant (validada server-side; ausente/ inválida ⇒ deshabilitado)
// ---------------------------------------------------------------------------

export interface ResolvedCoverageConfig {
  enabled: boolean;
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

export const MENSAJE_UBICACION_FALLO =
  'No pude registrar tu ubicación recién 🙏 Probá mandarla de nuevo en un momento.';

/** Mensaje de solicitud según canal: el botón nativo existe SOLO en WhatsApp (review). */
export function solicitudPara(cfg: ResolvedCoverageConfig, channel?: MessageChannel | null): string {
  if (channel && channel !== 'whatsapp') return MENSAJE_SOLICITUD_UBICACION_TEXTUAL;
  return cfg.requestMessage;
}

/** Valida la config cruda del tenant. Cualquier cosa rara ⇒ `enabled:false` (fail-safe). */
export function coverageSettings(config: CheckoutConfig | null | undefined): ResolvedCoverageConfig {
  const off: ResolvedCoverageConfig = { enabled: false, expiryHours: EXPIRY_DEFAULT_HOURS, requestMessage: MENSAJE_SOLICITUD_UBICACION, rejectedMessage: null };
  const raw = config?.coverage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return off;
  if ((raw as { enabled?: unknown }).enabled !== true) return off;
  const hours = (raw as { expiryHours?: unknown }).expiryHours;
  const expiryHours = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= EXPIRY_MAX_HOURS ? hours : EXPIRY_DEFAULT_HOURS;
  const msg = (raw as { requestMessage?: unknown }).requestMessage;
  const rej = (raw as { rejectedMessage?: unknown }).rejectedMessage;
  const requestMessage = typeof msg === 'string' && msg.trim() !== '' ? msg.trim().slice(0, MESSAGE_MAX) : MENSAJE_SOLICITUD_UBICACION;
  const rejectedMessage = typeof rej === 'string' && rej.trim() !== '' ? rej.trim().slice(0, MESSAGE_MAX) : null;
  return { enabled: true, expiryHours, requestMessage, rejectedMessage };
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

const cartSnapshotOf = (cart: Cart): CoverageRequest['cartSnapshot'] => ({
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

const purgeAtFrom = (now: Timestamp, req: Pick<CoverageRequest, 'location'>): Timestamp | null =>
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
}

/**
 * ETAPA C — Gate del checkout. null ⇒ el checkout sigue su camino normal (flag off, o
 * aprobación VIGENTE para la ubicación). Si intercepta: crea/reusa el request en una
 * transacción sobre la sesión (dos "pagar" concurrentes → un solo request) y pide la ubicación.
 */
export async function gateCoberturaCheckout(
  tenantId: string,
  customerId: string,
  cart: Cart,
  opts: { messageId?: string | null; simulation?: boolean; channel?: MessageChannel; receivedVia?: string | null },
): Promise<CoverageGateResult | null> {
  const cfg = coverageSettings(await getCheckoutConfig(tenantId));
  if (!cfg.enabled) return null;

  // Simulación (chat de prueba / test cases): mismo texto, CERO efectos operativos.
  if (opts.simulation === true) {
    return { reply: solicitudPara(cfg, opts.channel), locationRequest: true };
  }

  const sessionRef = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  const out = await db().runTransaction(async (tx) => {
    const ses = await tx.get(sessionRef);
    const ptr = (ses.data() as Session | undefined)?.context?.coverage ?? null;
    if (ptr) {
      const reqSnap = await tx.get(db().doc(requestPath(tenantId, ptr.requestId)));
      const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
      if (req && req.customerId === customerId && !TERMINALES.includes(req.status)) {
        const vencido = req.expiresAt.toMillis() <= now.toMillis();
        if (!vencido) {
          if (req.status === 'awaiting_location') return { kind: 'ask' as const, ptr: ptrOf(req, now) };
          if (req.status === 'pending_coverage_review') return { kind: 'pending' as const, ptr: ptrOf(req, now) };
          // coverage_approved VIGENTE: la aprobación vale para la ubicación aunque el carrito
          // haya cambiado (decisión de producto) → el checkout continúa por el camino normal.
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
      expiresAt: Timestamp.fromMillis(now.toMillis() + cfg.expiryHours * 60 * 60 * 1000),
      coordinatesPurgeAt: null,
    };
    tx.create(db().doc(requestPath(tenantId, id)), nuevo);
    const ptrNew = ptrOf(nuevo, now);
    tx.set(sessionRef, { context: { coverage: ptrNew }, updatedAt: now }, { merge: true });
    return { kind: 'ask' as const, ptr: ptrNew };
  });

  if (out.kind === 'approved') return null;
  if (out.kind === 'pending') return { reply: MENSAJE_UBICACION_EN_REVISION, coverage: out.ptr };
  logger.info('Cobertura: checkout en espera de ubicación', { tenantId, customer: `…${customerId.slice(-4)}`, requestId: out.ptr.requestId });
  return { reply: solicitudPara(cfg, opts.channel), locationRequest: true, coverage: out.ptr };
}

// ---------------------------------------------------------------------------
// Registro de ubicación (nativa o dirección escrita) — transaccional
// ---------------------------------------------------------------------------

type RegistroResultado =
  | { kind: 'ok'; requestId: string; primeraVez: boolean; humanTakeover: boolean; handoffReason: string | null; ptr: CoverageSessionPointer }
  | { kind: 'no_active' }
  | { kind: 'approved_activo' }
  | { kind: 'expired' };

async function registrarUbicacion(
  tenantId: string,
  customerId: string,
  location: CoverageLocation,
  wamid: string | null,
): Promise<RegistroResultado> {
  const sessionRef = db().doc(paths.session(tenantId, customerId));
  const now = Timestamp.now();
  return db().runTransaction(async (tx) => {
    const ses = await tx.get(sessionRef);
    const ctx = (ses.data() as Session | undefined)?.context;
    const ptr = ctx?.coverage ?? null;
    if (!ptr) return { kind: 'no_active' as const };
    const reqSnap = await tx.get(db().doc(requestPath(tenantId, ptr.requestId)));
    const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
    if (!req || req.customerId !== customerId || TERMINALES.includes(req.status)) return { kind: 'no_active' as const };
    if (req.status === 'coverage_approved') return { kind: 'approved_activo' as const }; // aprobado: no se re-abre solo
    if (req.expiresAt.toMillis() <= now.toMillis()) {
      tx.update(reqSnap.ref, { status: 'coverage_expired', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
      tx.set(sessionRef, { context: { coverage: null }, updatedAt: now }, { merge: true });
      return { kind: 'expired' as const };
    }
    const primeraVez = req.status === 'awaiting_location';
    const locationFingerprint = locationFingerprintOf(location);
    tx.update(reqSnap.ref, {
      location,
      locationFingerprint, // una ubicación nueva antes de la decisión INVALIDA la huella anterior
      status: 'pending_coverage_review',
      sourceMessageId: wamid ?? req.sourceMessageId ?? null,
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
 */
async function derivarARevision(
  tenantId: string,
  customerId: string,
  registro: Extract<RegistroResultado, { kind: 'ok' }>,
  wamid: string | null,
): Promise<{ reply: string; takeover: boolean }> {
  const config = await getCheckoutConfig(tenantId);
  const sellerName = vendedorParaCobertura(config);
  const hr = await executeHandoff(tenantId, customerId, {
    reason: 'coverage_review',
    sellerName: sellerName ?? undefined,
    sourceId: registro.requestId,
    createSessionIfMissing: false,
  });
  // Aviso a la campana: SIEMPRE tras persistir, deduplicado por wamid (un webhook repetido no
  // duplica; una ubicación NUEVA con wamid nuevo sí avisa — el equipo ve la actualización).
  await notifyHandoffRequested(tenantId, customerId, sellerName, wamid, 'coverage_review');
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
 * (jamás coordenadas/dirección). Devuelve la respuesta a entregar (puede ser '').
 */
export async function procesarUbicacionEntrante(input: UbicacionEntranteInput): Promise<{ reply: string }> {
  const { tenantId } = input;
  const customerId = input.from.replace(/[^0-9]/g, '');
  if (!customerId) return { reply: '' };
  const now = Timestamp.now();

  const ses = (await db().doc(paths.session(tenantId, customerId)).get()).data() as Session | undefined;
  const humanTakeover = ses?.context?.humanTakeover === true;

  // Historial: SOLO el placeholder — la ubicación exacta jamás entra a messages.
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

  const cfg = coverageSettings(await getCheckoutConfig(tenantId));
  let reply = '';
  let enTakeover = humanTakeover;
  try {
    if (!cfg.enabled) {
      reply = humanTakeover ? '' : MENSAJE_UBICACION_NO_PROCESABLE;
    } else {
      const location: CoverageLocation = {
        source: 'whatsapp_location',
        addressText: input.location.address,
        name: input.location.name,
        coordinates: { lat: input.location.latitude, lng: input.location.longitude },
      };
      const registro = await registrarUbicacion(tenantId, customerId, location, input.messageId);
      if (registro.kind === 'ok') {
        const r = await derivarARevision(tenantId, customerId, registro, input.messageId);
        reply = r.reply;
        enTakeover = enTakeover || r.takeover;
      } else if (registro.kind === 'expired') {
        reply = humanTakeover ? '' : MENSAJE_INTENTO_VENCIDO;
      } else if (registro.kind === 'approved_activo') {
        reply = humanTakeover ? '' : MENSAJE_ZONA_YA_CONFIRMADA;
      } else {
        reply = humanTakeover ? '' : MENSAJE_UBICACION_SIN_PEDIDO;
      }
    }
  } catch (e) {
    // G.10: si la persistencia falló, NO se confirma recepción ni pase — mensaje temporal honesto.
    logger.error('Cobertura: no se pudo registrar la ubicación', e, { tenantId, customer: `…${customerId.slice(-4)}` });
    reply = humanTakeover ? '' : MENSAJE_UBICACION_FALLO;
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
  return { reply };
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
    if (clasificacion === 'como_compartir') return { takeover: false, reply: ask, locationRequest: true };
    if (clasificacion === 'ambiguo') return { takeover: false, reply: MENSAJE_DIRECCION_AMBIGUA };

    if (clasificacion === 'cancelacion') {
      const now = Timestamp.now();
      const cancelado = await db().runTransaction(async (tx) => {
        const sesRef = db().doc(paths.session(tenantId, customerId));
        const ptr = ((await tx.get(sesRef)).data() as Session | undefined)?.context?.coverage ?? null;
        if (!ptr) return false;
        const reqSnap = await tx.get(db().doc(requestPath(tenantId, ptr.requestId)));
        const req = reqSnap.exists ? (reqSnap.data() as CoverageRequest) : null;
        if (!req || req.customerId !== customerId || TERMINALES.includes(req.status) || req.status === 'coverage_approved') return false;
        tx.update(reqSnap.ref, { status: 'coverage_cancelled', updatedAt: now, coordinatesPurgeAt: purgeAtFrom(now, req) });
        tx.set(sesRef, { context: { coverage: null }, updatedAt: now }, { merge: true });
        return true;
      });
      return cancelado ? { takeover: false, reply: MENSAJE_COBERTURA_CANCELADA, coverage: null } : null;
    }

    // 'direccion': saneada, con tope, registrada SIN pasar por la IA. El inbound ya se persistió
    // como placeholder (el engine lo reemplaza ANTES de escribir el historial).
    const addressText = text.replace(/\s+/g, ' ').trim().slice(0, 512);
    const location: CoverageLocation = { source: 'text', addressText, name: null, coordinates: null };
    const registro = await registrarUbicacion(tenantId, customerId, location, opts.messageId ?? null);
    if (registro.kind === 'expired') return { takeover: false, reply: MENSAJE_INTENTO_VENCIDO, coverage: null };
    if (registro.kind === 'approved_activo') return { takeover: false, reply: MENSAJE_ZONA_YA_CONFIRMADA };
    if (registro.kind === 'no_active') return null; // el flujo normal atiende el turno
    const r = await derivarARevision(tenantId, customerId, registro, opts.messageId ?? null);
    return { takeover: r.takeover, reply: r.reply, ...(r.takeover ? {} : { coverage: registro.ptr }) };
  } catch (e) {
    logger.error('Cobertura: no se pudo registrar la dirección', e, { tenantId, customer: `…${customerId.slice(-4)}` });
    return { takeover: false, reply: MENSAJE_UBICACION_FALLO };
  }
}
