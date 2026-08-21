/**
 * conversation/engine.ts — Motor de conversación del bot (F4)
 * ===========================================================
 * Recibe un mensaje, maneja la SESIÓN del cliente en Firestore y devuelve
 * una respuesta. Es channel-agnostic: NO sabe si la respuesta sale por WhatsApp
 * real o por el endpoint de prueba (ADR-0003). El cómo se entrega es del que llama.
 *
 * Fase 5: catálogo real + carrito. El cerebro de IA (Claude/GPT) se enchufa
 * más adelante, reemplazando la lógica por reglas de decidirRespuesta().
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { Session, SessionState, Product, Cart, MessageChannel, PendingCartConfirmation } from '@vpw/shared';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import {
  searchCatalog,
  getProductById,
  findProductByName,
  type CatalogFilters,
} from '../catalog/search.js';
import {
  pendingVigente,
  buildPendingConfirmation,
  tipoNegativa,
  tipoReclamoCarrito,
  esPreguntaConsulta,
  contieneNegacion,
  eleccionPorNombre,
  alignPresentedWithReply,
  preguntaDesambiguacion,
  PENDING_CART_TTL_MS,
} from './cartIntent.js';
import { addToCart, formatCart } from './cart.js';
import { getAgentConfig } from './agentConfig.js';
import { runSalesAgent } from '../ai/salesAgent.js';
import type { AiMessage } from '../ai/types.js';
import { appendMessage, listRecentMessages } from './messages.js';
import {
  enSilencio,
  EXIGE_SILENCIO_LIBRE,
  type ExpectativaDeSilencio,
  type OutboundDiferido,
} from './silencio.js';
import { queryTokens, esBusquedaSimilar } from '../catalog/match.js';
import { detectarOcasionContexto } from '../catalog/fichaRank.js';
import { veredictoOcasion, respuestaOcasionNoConviene, respuestaOcasionConviene } from './productOccasion.js';
import { esPosiblePedidoHumano, procesarPedidoHumano } from './humanRequest.js';
import { derivarPorIaNoDisponible, esConsultaDerivable } from './aiUnavailable.js';
import { esConsultaCobertura, RESPUESTA_COBERTURA_SEGURA } from './coverageGuard.js';
import { leerDeriva, driftGuardCableado, derivaActivaPara, evaluarDerivaSiAplica, resumenSaneado, SIN_DERIVA, type VeredictoDeriva } from '../catalog/driftGuard.js';
import { derivarPorDerivaCritica } from './driftHandoff.js';
import { gateCoberturaCheckout, clasificarTextoEnEspera, manejarTurnoEnEsperaUbicacion, actualizarUbicacionEnRevision } from './coverage.js';
import type { CoverageSessionPointer } from '@vpw/shared';
import { LEGACY_SESSION_KEY } from '@vpw/shared';
import { createPendingOrder, assertOrdenSinDerivaCritica, ProductNoVendibleError, ProductoConDerivaCriticaError } from '../orders/createPendingOrder.js';
import { resolveCheckoutReuse } from '../orders/checkoutReuse.js';
import { getCheckoutConfig, formatTransferInstructions } from '../orders/checkoutConfig.js';
import { avisarCheckoutSinDatos, MENSAJE_SIN_DATOS_DE_COBRO } from '../orders/checkoutUnconfigured.js';
import { captureTrackingCode } from '../tracking/tracking.js';
import { meterUsage, checkQuota } from '../entitlements/entitlements.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 horas

export interface ConversationInput {
  tenantId: string;
  from: string; // teléfono / id del cliente según el canal
  text: string;
  /** Canal de entrada (omnicanal, D2). Default 'whatsapp'. */
  channel?: MessageChannel;
  /** MULTI-NUMBER-1: phone_number_id del número del negocio que RECIBIÓ el mensaje. */
  receivedByPhoneNumberId?: string | null;
  /**
   * ADR-0017 §2 — CANAL de la conversación. La sesión (estado del motor, carrito, takeover,
   * pedido pendiente) es por número receptor, no por cliente: el mismo cliente puede estar
   * comprando por un número y consultando por otro.
   *
   * Omitirlo apunta al canal HEREDADO (`sessions/active`), que es donde viven todas las
   * conversaciones de hoy: el simulador del panel, el chat de prueba y los test cases siguen
   * exactamente igual.
   *
   * PENDIENTE DECLARADO (ADR-0017, consecuencias): `handoff.ts`, `coverage.ts` y el resto de los
   * ~25 llamadores todavía asumen el canal heredado. Migrarlos es CONDICIÓN para pasar un número
   * no-heredado a `live`; mientras ese número esté en `inactive` o `shadow`, el gate del webhook
   * impide que esos caminos se ejerciten.
   */
  sessionKey?: string;
  /** HANDOFF-2: wamid del mensaje entrante (idempotencia de avisos de handoff). */
  messageId?: string | null;
  /**
   * AI-FALLBACK-HONESTO-1: herramientas internas (chat de prueba del panel / test cases).
   * El fallback por IA-no-disponible se REPRESENTA (mismo texto) sin takeover ni aviso reales.
   */
  simulation?: boolean;
  /**
   * ADR-0016 §9: el turno lo trae un ADJUNTO y `text` es su CAPTION. Cambia DOS cosas, las dos
   * por seguridad:
   *
   *  1. NO se persiste el inbound. La burbuja del chat ya la creó la ingesta, con el marcador del
   *     sistema y el puntero al adjunto. Si el caption quedara como texto de un mensaje, entraría
   *     al prompt del modelo por el historial en el turno SIGUIENTE (prompt injection con un pie
   *     de foto). Mismo criterio que la dirección exacta en COVERAGE-1B.
   *  2. NO se delega en el modelo. El caption decide con las REGLAS determinísticas —una pregunta
   *     con foto no puede quedar sin respuesta— pero jamás se envía a la IA.
   */
  attachmentCaption?: boolean;
  /**
   * ADR-0016 §12: el caller se hace cargo del BORDE DE ENVÍO. Con esto en true el motor NO
   * persiste su propia burbuja de salida: devuelve el descriptor `outbound` y el caller escribe
   * el historial recién después del chequeo autoritativo de silencio y del envío físico.
   *
   * Por qué es opt-in y no el comportamiento único: solo el camino real de WhatsApp (process.ts)
   * tiene un envío que pueda contradecir al historial. El simulador del panel, el chat de prueba
   * y los test cases NO envían nada — ahí el motor sigue siendo el que registra, exactamente
   * como antes.
   */
  deferOutbound?: boolean;
}

export interface ConversationResult {
  reply: string;
  state: SessionState;
  /** true si el chat está en atención humana: el bot no generó respuesta. */
  handledByHuman?: boolean;
  /** COVERAGE-1B: el turno pide ubicación → el caller intenta el botón nativo (fallback textual). */
  locationRequest?: boolean;
  /**
   * KILL-SWITCH-1: activación bajo la que se generó un reply de cobertura. process.ts re-lee el
   * flag JUSTO antes del envío físico y NO manda el mensaje si el flujo se apagó/rotó en el medio.
   */
  coverageActivationId?: string | null;
  /**
   * ADR-0016 §12: presente SOLO con `deferOutbound`. Qué burbuja habría que escribir si la
   * respuesta efectivamente sale, y qué espera del silencio (una confirmación de handoff no se
   * mide con la misma vara que una respuesta autónoma del bot — ver `ExpectativaDeSilencio`).
   */
  outbound?: OutboundDiferido;
}

/** El teléfono (solo dígitos) sirve de id de cliente. */
function customerIdFromPhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

function esSaludo(text: string): boolean {
  return /\b(hola|buenas|buen[oa]s?\s+(d[ií]as|tardes|noches)|hi|hello|menu|men[uú]|inicio)\b/i.test(
    text.trim(),
  );
}

/**
 * F4 (saludo + intención): SOLO es saludo puro si al quitar el saludo y la cortesía no queda
 * contenido. "Hola, quiero un perfume para hombre" NO es saludo puro — la intención comercial
 * del mismo mensaje se procesa (IA/catálogo), no se corta el flujo con la bienvenida.
 * Exportada para tests.
 */
export function esSaludoPuro(text: string): boolean {
  if (!esSaludo(text)) return false;
  const resto = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    // Alternativas de MÁS LARGA a MÁS CORTA: la alternación es first-match-wins y "buenas+"
    // antes que "buenas tardes" dejaba "tardes" como residuo (review F4: el saludo más común
    // de es-PY se iba a la IA). "tardes|noches|dias" sueltos son relleno de saludo.
    .replace(/\b(buen[oa]s? (dias?|tardes|noches)|buen dia|buenas+|hola+|hi|hello|hey|menu|inicio|que tal|como (estas|andas|va)|todo bien|otra vez|de nuevo|tardes|noches|dias)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return resto.length <= 3;
}

const GS = (n: number) => '₲ ' + n.toLocaleString('es-PY');

/**
 * F6: versión BREVE de la bienvenida (para prefijar cuando el primer mensaje trae intención).
 * Respeta la bienvenida personalizada del tenant (primera línea, capada); si es muy larga o
 * vacía, cae a un saludo genérico corto. Pura y exportada para tests.
 */
export function saludoBreve(greeting: string | undefined | null): string {
  let linea = (greeting ?? '').split('\n')[0]!.trim();
  if (linea.length > 120) {
    // Cortar en el fin de la primera oración dentro del tope.
    linea = linea.slice(0, 120).match(/^.*[.!?…]/)?.[0]?.trim() ?? '';
  }
  // Quitar la(s) pregunta(s) de enganche del final ("¿Buscás algo para vos o para regalar?"):
  // el cliente YA preguntó algo — repreguntarle qué busca justo antes de responderle es absurdo
  // (review F6: los greetings default de provision son una línea que termina en pregunta).
  let previa;
  do {
    previa = linea;
    linea = linea.replace(/\s*¿[^?¿]*\?\s*$/u, '').trim();
  } while (linea !== previa);
  if (linea.length >= 3 && linea.length <= 120) return linea;
  return '¡Hola! 👋 Bienvenido/a.';
}

/**
 * F6: quita un saludo inicial de la respuesta de la IA cuando el sistema YA saluda (prefijo de
 * bienvenida breve) — sin esto el cliente recibía "¡Hola! Bienvenida…\n\n¡Hola! Sí, tenemos…".
 * Pura y exportada para tests.
 */
export function sinSaludoInicial(reply: string): string {
  const limpio = reply
    .replace(/^\s*(¡\s*)?(hola+|buenas+|buen[oa]s?\s+(d[ií]as?|tardes|noches)|buen d[ií]a|hey|hi|hello)(\s*!+)?[\s,.:;…—-]*/iu, '')
    .trimStart();
  // Si el saludo era TODO el mensaje, mejor dejar el original que devolver vacío.
  return limpio.length >= 2 ? limpio : reply;
}

function detectarEstilo(t: string): string | undefined {
  const mapa: Record<string, string[]> = {
    dulce: ['dulce', 'azucar', 'vainilla', 'gourmand'],
    floral: ['floral', 'flor', 'rosas', 'jazmin', 'jazmín'],
    fresco: ['fresco', 'fresc', 'ligero', 'verano', 'limpio'],
    intenso: ['intenso', 'fuerte', 'noche', 'seductor', 'potente'],
    'árabe': ['arabe', 'árabe', 'oud', 'lattafa'],
    'cítrico': ['citric', 'cítric', 'limon', 'limón'],
    frutal: ['frutal', 'fruta'],
    amaderado: ['amaderad', 'madera'],
  };
  for (const [estilo, kws] of Object.entries(mapa)) {
    if (kws.some((k) => t.includes(k))) return estilo;
  }
  return undefined;
}

/**
 * Género SOLO si el texto lo dice explícito; sin señal → undefined = sin filtro (F1).
 * (El default 'Femenino' dejaba catálogos 100% masculinos siempre vacíos.)
 * Exportada para tests.
 */
export function detectarGenero(t: string): string | undefined {
  if (/\b(para (e|é)l|hombre|masculino|caballero|novio|esposo)\b/.test(t)) return 'Masculino';
  if (/\b(para ella|mujer|femenin[oa]|dama|novia|esposa)\b/.test(t)) return 'Femenino';
  return undefined;
}

function detectarPrecio(t: string): { maxPrice?: number; priceRange?: string } {
  const mMil = t.match(/(\d+)\s*mil/);
  if (mMil) return { maxPrice: parseInt(mMil[1]!, 10) * 1000 };
  const mNum = t.match(/(\d{5,7})/);
  if (mNum) return { maxPrice: parseInt(mNum[1]!, 10) };
  if (/(econom|barat|accesible|poco)/.test(t)) return { priceRange: 'ACCESIBLE' };
  if (/(premium|caro|lujo|exclusiv)/.test(t)) return { priceRange: 'PREMIUM' };
  return {};
}

/**
 * Catálogo rule-based SOLO ante pedido explícito o señal clara (estilo/precio) (F1).
 * Palabras genéricas de compra (quiero/perfume/tenés/busco/recomend/ver/regalo) ya NO capturan:
 * esos turnos van al sales agent IA (ruleEngineWouldFallback), que busca con mejores parámetros.
 * Nota: detectarPrecio ya cubre barat/econom/accesible/premium/lujo como señal de precio.
 */
function quiereCatalogo(t: string): boolean {
  return (
    /\b(cat[aá]logo|mostr[aá]|muestr[ao]|mu[eé]strame|opciones)/.test(t) ||
    detectarEstilo(t) !== undefined ||
    Object.keys(detectarPrecio(t)).length > 0
  );
}

function emojiDe(p: Product): string {
  const s = p.perfume?.styleTags ?? [];
  if (s.includes('árabe') || s.includes('intenso')) return '🔥';
  if (s.includes('dulce') || s.includes('gourmand')) return '🍬';
  if (s.includes('fresco') || s.includes('cítrico')) return '🌊';
  return '🌸';
}

function formatearProductos(productos: Product[]): string {
  let out = '✨ Mirá, te elegí estas opciones:\n';
  for (const p of productos) {
    // Marca NEUTRAL con fallback al vertical y SIN separador si no hay: un producto genérico
    // sin `perfume` se listaba como "Nombre – undefined" en el WhatsApp real.
    const marca = (p.brand ?? p.perfume?.brand ?? '').trim();
    out += `\n${emojiDe(p)} *${p.name}${marca ? ` – ${marca}` : ''}* → ${GS(p.price)}`;
    if (p.inventory && p.inventory.stock <= 3) out += `  ⚠️ ¡Últimas ${p.inventory.stock}!`;
    if (p.featured) out += '\n   Uno de nuestros más vendidos 🌟';
  }
  out += '\n\n¿Cuál te gusta más? Decime el *número* o el *nombre* para agregarlo 🛒';
  return out;
}

function quiereVerCarrito(t: string): boolean {
  return /\b(carrito|mi pedido|qu[eé] llevo|qu[eé] tengo|mi compra)\b/.test(t);
}

/**
 * F2: los stems aceptan sufijos pegados ("agregalo", "sumala", "añadilo") — el regex anterior
 * exigía límite de palabra tras el stem y "agregá" matcheaba pero "agregalo" no (se iba a la IA,
 * que no puede escribir el carrito). También cubre "quiero ese/esta" y "me llevo ese".
 */
function quiereAgregar(t: string): boolean {
  // Ojo: nada de conjugaciones sueltas de "llevar" ("¿cuánto lleva el envío?" NO es agregar).
  return /\b(agreg\w*|añad\w*|anad\w*|sum[aá]|sumal[oa]|sumam[eé]|llevalo|llevala|me llevo|me (lo|la) llevo|(lo|la) quiero|(lo|la) llevo|quiero (ese|esa|este|esta))\b/.test(
    t,
  );
}

/**
 * F2/F3: confirmación corta y pura ("sí", "dale", "ok", "ese") — SIN tokens que nombren un
 * producto. Con una oferta pendiente VIGENTE equivale a "agregá el ofrecido" (lo decide el
 * caller, que conoce el estado y la oferta). Conservadora a propósito: "sí, pero tenés algo
 * más barato" NO es confirmación. Exportada para tests.
 */
export function esConfirmacionCorta(text: string): boolean {
  const t = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 30) return false;
  return /^(si+|dale|ok|okey|oka|listo|claro|obvio|perfecto|genial|bueno|de una|ese|esa|quiero ese|quiero esa)( (si+|dale|ok|okey|gracias|porfa|por favor|agregalo|agregala|sumalo|sumala|anadilo|anadila|quiero|ese|esa|lo|la))*$/.test(
    t,
  );
}

function quierePagar(t: string): boolean {
  return /\b(pagar|pago|finalizar|comprar|checkout|cobrar|terminar (compra|pedido))\b/.test(t);
}

/** Mapea "el primero/segundo/tercero" o "1/2/3" a un índice 0-based. */
function ordinalIndex(t: string): number | null {
  if (/\b(primero|primera|primer|1)\b/.test(t)) return 0;
  if (/\b(segundo|segunda|2)\b/.test(t)) return 1;
  if (/\b(tercero|tercera|3)\b/.test(t)) return 2;
  return null;
}

/**
 * ¿El motor rule-based mandaría este turno a su fallback genérico? (AG-3)
 * Es el ÚNICO bucket que se delega al sales agent de Claude: turnos conversacionales que las reglas
 * NO resuelven (no saludo, no carrito/pagar/seleccionar, no catálogo). Así el flujo de conversión
 * (navegar → elegir por número → carrito → pagar) y su `lastShownSkus` quedan 100% en las reglas.
 */
export function ruleEngineWouldFallback(text: string, t: string): boolean {
  return (
    // F4: el saludo solo retiene el turno si es PURO — "Hola, quiero un perfume para hombre"
    // lleva intención comercial y la atiende la IA (o el catálogo), no la bienvenida.
    !esSaludoPuro(text) &&
    !quiereVerCarrito(t) &&
    !quierePagar(t) &&
    !quiereAgregar(t) &&
    // F3: un ordinal solo retiene el turno en reglas si NO es pregunta — "¿cuánto sale el 2?"
    // es una consulta para la IA, no una selección (antes caía al fallback genérico mudo).
    (ordinalIndex(t) === null || esPreguntaConsulta(text)) &&
    !quiereCatalogo(t)
  );
}

/** Cuántos mensajes del historial recibe la IA como contexto (F1). */
const AI_HISTORY_MAX = 6;

/**
 * Historial persistido → mensajes para la IA (F1). Pura y exportada para tests.
 * Garantías para la Messages API de Anthropic: sin textos vacíos, roles alternados
 * (consecutivos del mismo lado se fusionan), empieza en 'user' y termina con el
 * turno actual del cliente (el inbound ya está persistido cuando se llama).
 */
export function buildAiHistory(
  history: Array<{ direction: string; text: string }>,
  currentText: string,
): AiMessage[] {
  const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of history) {
    const text = (m.text ?? '').trim();
    if (!text) continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${text}`;
    else msgs.push({ role, content: text });
  }
  while (msgs.length > 0 && msgs[0]!.role !== 'user') msgs.shift(); // la API exige empezar en 'user'
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') msgs.push({ role: 'user', content: currentText.trim() });
  return msgs;
}

/**
 * Decide la respuesta con las REGLAS (transaccional/navegacional). La IA atiende la cola
 * conversacional vía ruleEngineWouldFallback y el rescate de catálogo vacío (catalogEmpty, F1)
 * — ambos cableados en handleMessage. Exportada para tests (flag catalogEmpty).
 */
export async function decidirRespuesta(
  tenantId: string,
  customerId: string,
  text: string,
  esNuevo: boolean,
  prev: {
    cart: Cart;
    lastShownSkus: string[];
    greeting: string;
    profitMode: boolean;
    state: SessionState | null;
    /** F3: oferta pendiente VIGENTE (el caller ya filtró la vencida). */
    pendingCart?: PendingCartConfirmation | null;
    /** F3: había una oferta pero venció — una confirmación repregunta en vez de caer al genérico. */
    pendingExpirada?: boolean;
    /** F5: orden pendiente de la sesión (checkout idempotente: reusar, no duplicar). */
    pendingOrderId?: string | null;
    /** F3: reloj inyectable (tests); default Date.now(). */
    nowMs?: number;
    /** COVERAGE-1B: metadata del turno para el gate de cobertura (flag ON solamente). */
    coverageTurno?: { messageId?: string | null; simulation?: boolean; channel?: MessageChannel; receivedVia?: string | null; sessionKey?: string };
  },
): Promise<{
  reply: string;
  nextState: SessionState;
  cart?: Cart;
  lastShownSkus?: string[];
  /** F5: tri-estado — string = nueva orden · null = LIMPIAR el puntero · undefined = conservar. */
  pendingOrderId?: string | null;
  /** F1: la rama catálogo no encontró productos → el caller puede delegar a la IA antes del canned. */
  catalogEmpty?: boolean;
  /** F3: objeto = nueva oferta · null = limpiar · undefined = conservar la actual. */
  pendingCart?: PendingCartConfirmation | null;
  /** COVERAGE-1B: puntero de cobertura (tri-estado: objeto/null/undefined=conservar). */
  coverage?: CoverageSessionPointer | null;
  /** COVERAGE-1B: el turno pide ubicación → intentar el botón nativo con fallback textual. */
  locationRequest?: boolean;
  /** KILL-SWITCH-1: activación del reply de cobertura (process.ts re-lee el flag antes de enviar). */
  coverageActivationId?: string | null;
  /**
   * ADR-0015 §8: deriva CRÍTICA detectada en el camino del checkout. El motor no deriva por su
   * cuenta (la transición canónica escribe la sesión y handleMessage debe respetarla): devuelve
   * el veredicto SANEADO y handleMessage hace el pase con `executeHandoff`.
   */
  driftBlock?: VeredictoDeriva;
}> {
  const t = text.toLowerCase();

  // 1a. Cliente nuevo con saludo PURO → bienvenida completa (configurable desde el panel).
  //     F6: si el primer mensaje trae INTENCIÓN ("Hola, tenés Supremacy?"), NO se corta acá:
  //     la intención sigue su curso (motor/IA) y handleMessage antepone la bienvenida breve.
  if (esNuevo && esSaludoPuro(text)) {
    return {
      reply:
        prev.greeting ||
        '¡Hola! 💖 Bienvenida a *Perfumería AFG*. Soy Sofía, tu asesora.\n' +
          '¿Buscás algo para vos o para regalar? Contame qué estilo te gusta ' +
          '(dulce, floral, fresco, intenso...) y te muestro opciones ✨',
      nextState: 'BROWSING',
    };
  }
  // 1b. Cliente que vuelve y saluda → bienvenida corta (no repetir el intro completo).
  //     F4: SOLO si es saludo puro — "Hola, mostrame el catálogo" procesa la intención.
  if (esSaludoPuro(text)) {
    return {
      reply:
        '¡Hola de nuevo! 🌸 ¿Te ayudo con algo más? Decime qué estilo buscás ' +
        '(dulce, floral, fresco, intenso) o escribí *catálogo*.',
      nextState: 'BROWSING',
    };
  }

  // 2. Ver carrito
  if (quiereVerCarrito(t)) {
    return { reply: formatCart(prev.cart), nextState: 'CART' };
  }

  // 3. Pagar → crear pre-orden + link de pago. F5: checkout IDEMPOTENTE — repreguntar por los
  //    datos de transferencia ("Para pagar cuál es") reenvía la orden pendiente, no crea otra.
  if (quierePagar(t)) {
    if (prev.cart.items.length === 0) {
      return {
        reply: '🛒 Tu carrito está vacío. Agregá algún perfume primero (escribí *catálogo*).',
        nextState: 'BROWSING',
      };
    }

    // F5 PRIMERO (COVERAGE-CHECKOUT-REUSE-GATE-1 — hallazgo MEDIO de ACTIVATION-AUDIT-2): el
    // pedido REUTILIZABLE/abierto se resuelve ANTES de que Coverage pueda iniciar una
    // cotización — "pagar" repetido reenvía el MISMO pedido (o avisa que el comprobante está
    // en revisión) y JAMÁS dispara un request/REQUOTE sobre una orden abierta.
    const decision = await resolveCheckoutReuse(tenantId, customerId, prev.pendingOrderId ?? null, prev.cart);
    if (decision.kind === 'reuse') {
      // ADR-0015 §8: reenviar los datos bancarios y el total de un pedido abierto AFIRMA un precio
      // igual que crear la orden — y este camino retorna ANTES de createPendingOrder, donde vive el
      // freno. Sin esto, "pagar" repetido sobre una orden ya creada seguía mandando banco y total de
      // un producto cuyo dato público no podemos confirmar. Se revisa lo que pide LA ORDEN (es lo
      // que se está por cobrar), no el carrito actual.
      //
      // Se usa `assertOrdenSinDerivaCritica` —la MISMA definición que aplican createPendingOrder y
      // la reanudación por cobertura— y no el evaluador conversacional: acá hay dinero
      // comprometido, así que es FAIL-CLOSED. Antes esta rama usaba `evaluarDerivaSiAplica`, que
      // ante un error de lectura de la proyección devuelve "sin deriva": un parpadeo de Firestore
      // alcanzaba para reenviar banco y total de un precio que no se pudo verificar. Como manda el
      // ADR, la rama de reuso vuelve a preguntar. De paso hereda la otra regla del helper: una
      // orden sin ítems legibles es `unverifiable`, porque mandar el total de algo que no sabemos
      // atribuir es exactamente lo que este guard impide.
      try {
        await assertOrdenSinDerivaCritica(tenantId, decision.order.id, decision.order.items, {
          customerId,
          motivo: 'checkout_idempotente_reuse',
        });
      } catch (e) {
        if (!(e instanceof ProductoConDerivaCriticaError)) throw e;
        return {
          reply: '',
          // Se conserva el estado del pago (el pedido sigue abierto): el pase a humano lo hace
          // handleMessage y nadie degrada un AWAITING_PAYMENT por este camino.
          nextState: prev.state ?? 'CART',
          pendingOrderId: decision.order.id, // el puntero se repara igual: la orden no desaparece
          driftBlock: e.veredicto,
        };
      }
      const config = await getCheckoutConfig(tenantId);
      const instrucciones = formatTransferInstructions(config, decision.order.totals.total);
      // H-04: sin cuentas cobrables no hay datos que reenviar. Antes salían los placeholders del
      // seed; concatenar el null tampoco es opción (el cliente leería "null").
      if (!instrucciones) {
        await avisarCheckoutSinDatos(tenantId, customerId).catch(() => false);
        logger.warn('Checkout idempotente sin datos de cobro: no se reenvian instrucciones', { tenantId, customerId, orderId: decision.order.id });
        return {
          reply: MENSAJE_SIN_DATOS_DE_COBRO,
          nextState: 'AWAITING_PAYMENT',
          pendingOrderId: decision.order.id,
          pendingCart: null,
        };
      }
      logger.info('Checkout idempotente: se reenvía la orden pendiente', { tenantId, customerId, orderId: decision.order.id, repaired: decision.repaired });
      return {
        reply: 'Seguís con tu pedido pendiente 🧾 Te reenvío los datos:\n\n' + instrucciones,
        nextState: 'AWAITING_PAYMENT',
        pendingOrderId: decision.order.id, // mismo id (y repara el puntero si se había perdido)
        pendingCart: null,
      };
    }
    if (decision.kind === 'verification') {
      return {
        reply: '📸 Tu comprobante ya está en revisión 🙌 Ni bien lo confirmemos te avisamos por acá — no hace falta pagar de nuevo.',
        nextState: 'AWAITING_PAYMENT',
        pendingOrderId: decision.order.id,
        pendingCart: null,
      };
    }
    if (decision.kind === 'paid') {
      // Cierra lo que confirmPayment no llegó a limpiar (puntero/carrito stale): sin esto el
      // cliente quedaba en loop de "ya figura pagado" sin poder comprar de nuevo (review F5).
      return {
        reply: '✅ Tu pedido ya figura pagado y confirmado. Si querés hacer una compra nueva, decime qué buscás o escribí *catálogo*.',
        nextState: 'BROWSING',
        cart: { items: [], subtotal: 0 }, // lo del carrito ya se pagó en esa orden
        pendingOrderId: null,
        pendingCart: null,
      };
    }
    // COVERAGE-1B: el gate corre SOLO para una compra realmente NUEVA (decisiones new /
    // new_cart_changed — el pedido reutilizable/abierto ya retornó arriba): con
    // `coverage.enabled` y SIN aprobación vigente, el checkout se frena ANTES de crear orden /
    // mostrar banco / consumir cuota. El gate no toca pendingOrderId ni la orden anterior.
    // Flag off ⇒ gate null ⇒ F5 intacto.
    const gate = await gateCoberturaCheckout(tenantId, customerId, prev.cart, prev.coverageTurno ?? {});
    if (gate) {
      return {
        reply: gate.reply,
        nextState: 'CART',
        pendingCart: null, // el checkout congela el contexto de oferta (mismo criterio que pagar)
        ...(gate.coverage !== undefined ? { coverage: gate.coverage } : {}),
        ...(gate.locationRequest ? { locationRequest: true } : {}),
        ...(gate.coverageActivationId !== undefined ? { coverageActivationId: gate.coverageActivationId } : {}),
      };
    }

    const avisoCambio =
      decision.kind === 'new_cart_changed'
        ? 'Como tu carrito cambió, te generé un pedido nuevo 🧾\n\n'
        : '';
    // PLAN-LIMITS-3A: gate de órdenes. Hoy lo que bloquea es el CUPO MENSUAL (maxOrdersPerMonth); checkQuota
    // también cubriría una suspensión por billing, pero por diseño la cuenta NUNCA se suspende
    // (billingPosture.operational siempre true → los datos se preservan). Si se bloquea: NO creamos la orden
    // ni medimos, y al CLIENTE final le damos un mensaje SEGURO (sin exponer el plan): lo derivamos a un
    // asesor. Auditoría segura (logger, sin PII). Nota: cuota mensual "blanda" (read+increment no atómico,
    // igual que el resto de las cuotas del repo) → bajo concurrencia puede sobrepasarse por ~1 orden.
    const oq = await checkQuota(tenantId, 'orders');
    if (!oq.allowed) {
      logger.info('Orden bloqueada por cuota del plan', { tenantId, metric: 'orders', used: oq.used, limit: oq.limit, reason: oq.reason });
      return {
        reply: 'En un momento un asesor te contacta para finalizar tu pedido 🙌',
        nextState: 'CART',
      };
    }
    let order: Awaited<ReturnType<typeof createPendingOrder>>;
    try {
      // ADR-0017 §2: el pedido se queda con el canal que lo armó. Quien confirme el pago después
      // (webhook de la pasarela, callable del panel) no tiene el turno a mano: sin este dato,
      // cerraba el checkout de `active` — con dos números, el de la conversación equivocada.
      order = await createPendingOrder(tenantId, customerId, prev.cart, { sessionKey: prev.coverageTurno?.sessionKey });
    } catch (e) {
      // ADR-0015 §8: el precio/disponibilidad/stock público de algún producto del carrito lo
      // gobierna una fuente externa que HOY publica otra cosa ⇒ la orden no nace y los datos
      // bancarios no salen. Se evalúa ANTES que ProductNoVendibleError porque la deriva es una
      // subclase suya a propósito (mismo freno del pedido, distinta razón y distinto mensaje):
      // el pase a humano lo hace handleMessage con el servicio canónico.
      if (e instanceof ProductoConDerivaCriticaError) {
        return { reply: '', nextState: 'CART', driftBlock: e.veredicto };
      }
      // El carrito quedó con algo que ya no se puede vender (desactivado / sin stock desde que
      // se armó). Respuesta honesta, SIN crear pedido ni prometer disponibilidad.
      if (e instanceof ProductNoVendibleError) {
        return {
          reply: `Uy, ${e.productNames.length === 1 ? 'un producto de tu carrito ya no está disponible' : 'algunos productos de tu carrito ya no están disponibles'} 😕 Te paso con alguien del equipo para resolverlo.`,
          nextState: 'CART',
        };
      }
      throw e;
    }
    // Medición 1:1 con la creación EXITOSA (va después de createPendingOrder; si la creación lanza, no
    // se incrementa ordersThisMonth). No bloqueante: el metering nunca rompe el pago.
    await meterUsage(tenantId, 'orders').catch(() => { /* metering no crítico */ });
    const config = await getCheckoutConfig(tenantId);
    const instrucciones = formatTransferInstructions(config, order.totals.total);
    // H-04: el pedido YA quedó creado; lo que no existe son los datos para pagarlo. Se le dice al
    // cliente sin inventar una cuenta, y el dueño se entera por la campana.
    if (!instrucciones) {
      await avisarCheckoutSinDatos(tenantId, customerId).catch(() => false);
      logger.warn('Checkout sin datos de cobro: el pedido queda creado y el equipo debe contactar', { tenantId, customerId, orderId: order.id });
      return {
        // `avisoCambio` se conserva: si el carrito cambió, el cliente tiene que saber que este
        // pedido es OTRO, aunque todavía no pueda pagarlo.
        reply: avisoCambio + MENSAJE_SIN_DATOS_DE_COBRO,
        nextState: 'AWAITING_PAYMENT',
        pendingOrderId: order.id,
        pendingCart: null,
      };
    }
    return {
      reply: avisoCambio + instrucciones,
      nextState: 'AWAITING_PAYMENT',
      pendingOrderId: order.id,
      pendingCart: null, // F3: el checkout congela el contexto de oferta (no arrastra a la próxima)
    };
  }

  // 4. Agregar al carrito — F3: resolución CONTEXTUAL y determinística contra la oferta vigente.
  //    Prioridades: nombre en el mensaje ACTUAL > índice ("el primero") > único candidato claro.
  //    El caller ya filtró la oferta vencida (pendingCart llega null si expiró) — contexto viejo
  //    NUNCA agrega. La IA jamás toca este camino: solo conversa.
  const nowMs = prev.nowMs ?? Date.now();
  const pending = prev.pendingCart ?? null;

  // Guarda DURA de negación (review F3): "no lo quiero" contiene "(lo) quiero" y engañaba a
  // quiereAgregar → agregaba lo RECHAZADO. Con negación no se agrega NADA; si además hay oferta
  // (y no es una pregunta tipo "¿no tenés el invictus?"), se descarta la oferta con cierre amable.
  const negacion = contieneNegacion(text);
  if (negacion && pending && !esPreguntaConsulta(text)) {
    return {
      reply: 'Dale 👍 no lo agrego. Si querés, contame qué estilo buscás o escribí *catálogo* y vemos otras opciones.',
      nextState: 'BROWSING',
      pendingCart: null,
    };
  }

  // 4a. Nombre con verbo de agregar ("agregame el Supremacy") → catálogo completo. Prioridad
  //     ABSOLUTA: gana aunque la oferta vigente tenga otro producto primero.
  let seleccion: Product | null = null;
  if (!negacion && quiereAgregar(t)) {
    seleccion = (await findProductByName(tenantId, t)) ?? null; // exige ≥1 token del NOMBRE
  }

  // 4b. ELECCIÓN por nombre sin verbo respondiendo a la oferta ("El Supremacy quiero").
  //     eleccionPorNombre es estricta: preguntas, negaciones y opiniones que solo MENCIONAN al
  //     candidato ("me encanta el supremacy pero está caro") devuelven [] → van a la IA.
  if (!seleccion && !negacion && pending) {
    const elegidos = eleccionPorNombre(text, pending.products);
    if (elegidos.length === 1) {
      seleccion = await getProductById(tenantId, elegidos[0]!.id);
    } else if (elegidos.length > 1) {
      return {
        reply: preguntaDesambiguacion(elegidos),
        nextState: 'VIEWING_PRODUCT',
        pendingCart: buildPendingConfirmation(elegidos, pending.source, nowMs),
      };
    }
  }

  // 4c. Índice ("el primero", "el 2", "opción 3"): contra la oferta vigente (el orden que el
  //     cliente LEYÓ); sin oferta, legacy sobre lastShownSkus. Una PREGUNTA con número
  //     ("¿cuánto sale el 2?") es consulta, no elección — jamás agrega.
  if (!seleccion && !negacion && !esPreguntaConsulta(text)) {
    const idx = ordinalIndex(t);
    if (idx !== null) {
      // Con oferta VENCIDA el legacy no aplica: "el primero" sobre contexto viejo jamás agrega.
      const targetId = pending
        ? pending.products[idx]?.id
        : prev.pendingExpirada
          ? undefined
          : prev.lastShownSkus[idx];
      if (targetId) seleccion = await getProductById(tenantId, targetId);
    }
  }

  // 4d. Confirmación/intención SIN nombre ("sí", "dale", "agregalo", "quiero ese"). La guarda
  //     queryTokens (heredada de F2) es clave: si el cliente NOMBRÓ algo que no se resolvió
  //     arriba ("agregame el invictus" que no existe), acá NO se agrega otra cosa a ciegas.
  if (!seleccion && !negacion && (quiereAgregar(t) || esConfirmacionCorta(text)) && queryTokens(text).length === 0) {
    if (pending) {
      if (!pending.needsDisambiguation && pending.primaryProductId) {
        // Único candidato claro y vigente → ese, exactamente ese.
        seleccion = await getProductById(tenantId, pending.primaryProductId);
      } else {
        // Varios candidatos y un "sí" pelado → NO adivinar: que elija (lista del MOTOR,
        // numeración garantizada). La oferta se renueva para que "el 2" funcione después.
        return {
          reply: preguntaDesambiguacion(pending.products),
          nextState: 'VIEWING_PRODUCT',
          pendingCart: { ...pending, expiresAtMs: nowMs + PENDING_CART_TTL_MS },
        };
      }
    } else if (
      !prev.pendingExpirada && // oferta vencida ⇒ nada de legacy: contexto viejo no agrega
      prev.state === 'VIEWING_PRODUCT' &&
      prev.lastShownSkus.length > 0
    ) {
      // Legacy (sesiones anteriores a F3, sin oferta guardada): con UN solo mostrado se agrega
      // ese; con varios NUNCA "el primero" a ciegas — se leen los nombres y se desambigua.
      if (prev.lastShownSkus.length === 1) {
        seleccion = await getProductById(tenantId, prev.lastShownSkus[0]!);
      } else {
        const prods = (
          await Promise.all(prev.lastShownSkus.slice(0, 3).map((id) => getProductById(tenantId, id)))
        ).filter((p): p is Product => !!p);
        if (prods.length === 1) {
          seleccion = prods[0]!;
        } else if (prods.length > 1) {
          const cands = prods.map((p) => ({ id: p.id, name: p.name }));
          return {
            reply: preguntaDesambiguacion(cands),
            nextState: 'VIEWING_PRODUCT',
            pendingCart: buildPendingConfirmation(cands, 'catalog_listing', nowMs),
          };
        }
      }
    }
  }

  if (seleccion) {
    // ADR-0015 §8: agregar ANUNCIA un total, así que es una afirmación de precio más. El guard del
    // turno ya cubre el producto nombrado y la oferta vigente; acá se cierra el caso legacy (sesión
    // vieja sin oferta guardada que resuelve por `lastShownSkus`), que no pasa por ninguno de los dos.
    const derivaSel = await evaluarDerivaSiAplica(tenantId, [{ id: seleccion.id, name: seleccion.name }]);
    if (derivaSel.bloqueantes.length) {
      // Sin tocar el carrito: la ADR pide conservarlo tal cual y derivar.
      return { reply: '', nextState: prev.state ?? 'BROWSING', pendingCart: null, driftBlock: derivaSel };
    }
    const cart = addToCart(prev.cart, seleccion);
    const unidades = cart.items.reduce((n, i) => n + i.quantity, 0);
    return {
      reply:
        `✅ Agregué *${seleccion.name}* a tu carrito.\n` +
        `🛒 Llevás ${unidades} producto(s) — Total: ${GS(cart.subtotal)}\n\n` +
        'Seguí mirando (*catálogo*) o escribí *carrito* / *pagar*.',
      nextState: 'CART',
      cart,
      pendingCart: null, // F3: oferta consumida — nunca re-agrega con otro "sí" posterior
    };
  }
  if (
    !negacion &&
    (quiereAgregar(t) ||
      (esConfirmacionCorta(text) && (prev.pendingExpirada || prev.state === 'VIEWING_PRODUCT')))
  ) {
    // Intención de agregar sin candidato resoluble (incluye oferta VENCIDA): repreguntar, no
    // adivinar. Un "sí" sin NINGÚN contexto de compra sigue cayendo al fallback genérico.
    // Se limpia TODO el contexto de oferta (también lastShownSkus): la invitación "número o
    // nombre" no puede resolverse después contra una lista vieja que el cliente ya no ve.
    return {
      reply: 'Decime cuál querés agregar 🙂 — el *número* (1, 2, 3) o el *nombre* del perfume.',
      nextState: 'VIEWING_PRODUCT',
      pendingCart: null,
      lastShownSkus: [],
    };
  }

  // 5. Catálogo / búsqueda
  if (quiereCatalogo(t)) {
    const filtros: CatalogFilters = {
      // F7 (review): si el turno NOMBRA un producto/marca ("mostrame el supremacy", "tenes X o
      // algo dulce" sin "?"), la fidelidad estricta aplica también en esta ruta rule-based —
      // antes solo la IA la tenía y la cobertura dependía del signo de pregunta.
      query: t,
      allowSimilar: esBusquedaSimilar(t),
      gender: detectarGenero(t),
      styleTag: detectarEstilo(t),
      ...detectarPrecio(t),
      limit: 3,
      profitMode: prev.profitMode,
      texto: t, // CAT-2: la ficha (ocasión/notas/cuándo-NO) pesa en el orden del listado
    };
    const productos = await searchCatalog(tenantId, filtros);
    if (productos.length === 0) {
      return {
        reply:
          'Mmm, no encontré algo que encaje justo con eso 🤔. ¿Querés que te muestre ' +
          'nuestros más vendidos, o ajustamos el presupuesto?',
        nextState: 'BROWSING',
        catalogEmpty: true, // F1: el caller intenta el sales agent IA antes de mandar este canned
      };
    }
    return {
      reply: formatearProductos(productos),
      nextState: 'VIEWING_PRODUCT',
      lastShownSkus: productos.map((p) => p.id),
      // F3: el listado ES la oferta — mismo array que arma el texto ⇒ numeración SIEMPRE alineada.
      pendingCart: buildPendingConfirmation(
        productos.map((p) => ({ id: p.id, name: p.name })),
        'catalog_listing',
        nowMs,
      ),
    };
  }

  // 6. Fallback
  return {
    reply:
      'Puedo ayudarte a encontrar tu perfume ideal 🌸. Decime qué estilo buscás ' +
      '(dulce, floral, fresco, intenso) o escribí *catálogo* para ver opciones.',
    nextState: 'BROWSING',
  };
}

/**
 * F4 (anti-mentiras): responde un RECLAMO del cliente con el estado REAL del carrito — jamás
 * la IA, que en prod inventó "Ya lo agregué" con el carrito vacío. Si el reclamo nombra un
 * producto real, queda como oferta pendiente: el próximo "sí" lo agrega (reclamo ≠ consentimiento,
 * acá no se agrega nada a ciegas). Devuelve null cuando el turno NO debe interceptarse:
 *  - 'debil' sin producto nombrado ("yo quería saber si hacen envíos") → IA.
 *  - 'debil' que nombra un candidato de la oferta VIGENTE → lo resuelve la elección por nombre (4b).
 */
export async function interceptarReclamoCarrito(
  tenantId: string,
  text: string,
  prev: { cart: Cart; pendingVigente: PendingCartConfirmation | null; nowMs: number; enPago?: boolean },
  tipo: 'fuerte' | 'debil',
): Promise<{ reply: string; nextState: SessionState; pendingCart?: PendingCartConfirmation | null; lastShownSkus?: string[]; driftBlock?: VeredictoDeriva } | null> {
  const nombrado = (await findProductByName(tenantId, text)) ?? null;
  if (tipo === 'debil') {
    if (!nombrado) return null;
    if (prev.pendingVigente?.products.some((p) => p.id === nombrado.id)) return null; // elección (4b)
  }

  // Post-checkout (AWAITING_PAYMENT) el carrito de la sesión conserva lo ya pedido (review F4):
  // un reclamo acá NO puede ofrecer "pagar" ni re-agregar — el pedido existe y lo ve el vendedor.
  // Esta rama no cotiza nada, así que tampoco necesita preguntar por la deriva.
  if (prev.enPago) {
    return {
      reply:
        'Tu pedido ya quedó registrado 🙌 Estamos revisando el pago y en breve te confirmamos por acá. ' +
        'Si querés cambiar algo del pedido, avisanos y un vendedor te ayuda.',
      nextState: 'AWAITING_PAYMENT',
      pendingCart: null,
    };
  }

  // ADR-0015 §8: de acá para abajo TODAS las ramas afirman precios — el del producto reclamado
  // ("¿Querés que agregue el *X* (₲ …)?") y el detalle+total del carrito. Este interceptor corre
  // ANTES del guard del turno (el guard solo evalúa si ningún interceptor resolvió el turno), así
  // que la consulta de deriva tiene que hacerla él mismo o el precio divergente sale igual.
  const enJuegoReclamo = [
    ...(nombrado ? [{ id: nombrado.id, name: nombrado.name }] : []),
    ...prev.cart.items.map((i) => ({ id: i.productId, name: i.name })),
  ];
  const derivaReclamo = await evaluarDerivaSiAplica(tenantId, enJuegoReclamo);
  if (derivaReclamo.bloqueantes.length) {
    return { reply: '', nextState: 'CART', pendingCart: null, driftBlock: derivaReclamo };
  }

  const items = prev.cart.items;
  if (items.length === 0) {
    if (nombrado) {
      return {
        // 'debil' suele ser un PEDIDO cortés ("yo quería el X"), no una queja: sin disculpas raras.
        reply:
          (tipo === 'fuerte'
            ? `Tenés razón 🙏 Todavía no agregué nada al carrito.\n`
            : `¡Dale! 🙌 `) + `¿Querés que agregue el *${nombrado.name}* (${GS(nombrado.price)})?`,
        nextState: 'VIEWING_PRODUCT',
        pendingCart: buildPendingConfirmation([{ id: nombrado.id, name: nombrado.name }], 'catalog_listing', prev.nowMs),
        lastShownSkus: [nombrado.id],
      };
    }
    return {
      reply: 'Tenés razón 🙏 Todavía no agregué nada al carrito. Decime cuál querés y lo agrego.',
      nextState: 'VIEWING_PRODUCT',
      pendingCart: null,
    };
  }

  const lista = items.map((i) => `• ${i.name} x${i.quantity}`).join('\n');
  const resumen = `${lista}\nTotal: ${GS(prev.cart.subtotal)}`;
  if (nombrado && items.some((i) => i.productId === nombrado.id)) {
    return {
      reply: `Sí — el *${nombrado.name}* está en tu carrito ✅\n${resumen}\n\n¿Querés *pagar* o seguís mirando?`,
      nextState: 'CART',
      // La pregunta ahora es OTRA ("¿pagás?"): una oferta vieja no puede capturar el próximo "sí".
      pendingCart: null,
    };
  }
  if (nombrado) {
    return {
      reply:
        `Este es tu carrito hoy 🛒\n${resumen}\n\n` +
        `El *${nombrado.name}* todavía NO está. ¿Querés que lo agregue?`,
      nextState: 'VIEWING_PRODUCT',
      pendingCart: buildPendingConfirmation([{ id: nombrado.id, name: nombrado.name }], 'catalog_listing', prev.nowMs),
      lastShownSkus: [nombrado.id],
    };
  }
  return {
    reply: `Reviso tu carrito real 🛒\n${resumen}\n\n¿Está bien así o querés cambiar algo?`,
    nextState: 'CART',
    // Ídem: "¿está bien así?" es una pregunta nueva — descartar cualquier oferta previa.
    pendingCart: null,
  };
}

/**
 * CAT-2B: pregunta "¿PRODUCTO sirve para OCASIÓN?" — respuesta HONESTA desde el motor con la
 * ficha. El bug real de prod: estas preguntas caían al listado genérico (detectarEstilo mapea
 * 'noche'→'intenso' y quiereCatalogo captura ANTES del gate de la IA), en loop y sin responder.
 *
 * Devuelve:
 *  - { tipo:'respuesta' }  → veredicto de la ficha: cuándo-NO → corrección honesta + alternativa
 *    del ranking CAT-2 (excluyendo el consultado) con oferta pendiente; sí → confirmación + oferta.
 *  - { tipo:'delegar' }    → pregunta sobre producto SIN señal suficiente en la ficha (o sin
 *    ocasión pero con quiereCatalogo que la capturaría): va a la IA, JAMÁS al listado genérico.
 *  - null                  → no es una pregunta producto+ocasión; sigue el ruteo normal.
 *
 * El producto sale del matcher por nombre (F1B) o, con anáfora ("ese/este"), de la oferta
 * pendiente VIGENTE / único último mostrado — nunca se adivina entre varios.
 */
export async function interceptarPreguntaProductoOcasion(
  tenantId: string,
  text: string,
  t: string,
  prev: { pendingVigente: PendingCartConfirmation | null; lastShownSkus: string[]; nowMs: number },
): Promise<
  | { tipo: 'respuesta'; result: { reply: string; nextState: SessionState; pendingCart: PendingCartConfirmation | null; lastShownSkus: string[]; driftBlock?: VeredictoDeriva } }
  | { tipo: 'delegar' }
  | null
> {
  const esPregunta = esPreguntaConsulta(text) || /\b(sirve|servir[ií]a|va bien|funciona|anda) (para|de|en)\b/.test(t);
  if (!esPregunta) return null;
  // Review CAT-2B: los turnos TRANSACCIONALES nunca se interceptan — "¿me agregás el X para la
  // noche?" es un agregado y "¿puedo pagar el X esta noche?" es un pago, aunque traigan "?" y
  // ocasión. El flujo de conversión (F2/F5) tiene prioridad.
  if (quierePagar(t) || quiereAgregar(t) || quiereVerCarrito(t)) return null;
  // Review CAT-2B: logística de entrega ("¿me lo mandás esta noche?") — 'esta noche' ahí es un
  // horario, no una ocasión de uso. Se deja al ruteo normal.
  if (/\b(mand|env[ií]|entreg|lleg|retir|deposit|transfer)\w*/.test(t)) return null;

  // Producto: nombrado ("el mega sirve...") → anafórico ("ese sirve..." → oferta vigente/único
  // mostrado) → ordinal ("¿el 2 sirve para la noche?" → producto 2 de la oferta vigente).
  let producto = await findProductByName(tenantId, text);
  if (!producto && /\b(ese|esa|este|esta|eso)\b/.test(t)) {
    const id =
      prev.pendingVigente?.primaryProductId ??
      (prev.pendingVigente?.products.length === 1 ? prev.pendingVigente.products[0]!.id : null) ??
      (prev.lastShownSkus.length === 1 ? prev.lastShownSkus[0]! : null);
    if (id) producto = await getProductById(tenantId, id);
  }
  if (!producto) {
    const idx = ordinalIndex(t);
    const porOrdinal = idx !== null ? (prev.pendingVigente?.products[idx] ?? null) : null;
    if (porOrdinal) producto = await getProductById(tenantId, porOrdinal.id);
  }
  if (!producto) return null;

  // ADR-0015 §8: este interceptor también corre ANTES del guard del turno y sus dos respuestas
  // afirman disponibilidad ("¿Te lo agrego?") y, con alternativa, un precio. Se pregunta acá, con
  // el producto ya resuelto. La ALTERNATIVA no hace falta chequearla: sale de `searchCatalog`, que
  // ya excluye lo que no podemos afirmar.
  const derivaOcasion = await evaluarDerivaSiAplica(tenantId, [{ id: producto.id, name: producto.name }]);
  if (derivaOcasion.bloqueantes.length) {
    return {
      tipo: 'respuesta',
      result: { reply: '', nextState: 'VIEWING_PRODUCT', pendingCart: null, lastShownSkus: [], driftBlock: derivaOcasion },
    };
  }

  const ocasion = detectarOcasionContexto(text);
  if (!ocasion) {
    // Pregunta sobre un producto sin ocasión ("¿el odyssey es dulce?"): si el catálogo la
    // capturaría (estilo/precio en el texto), delegamos a la IA; si no, el ruteo normal ya la manda.
    return quiereCatalogo(t) ? { tipo: 'delegar' } : null;
  }

  const veredicto = veredictoOcasion(producto, ocasion);
  if (veredicto === 'sin_senal') return { tipo: 'delegar' };

  if (veredicto === 'no_conviene') {
    // Alternativa del ranking CAT-2 (texto → ficha ordena por ocasión). SIN profitMode a propósito:
    // la corrección honesta se argumenta por ficha, no por margen. Review CAT-2B: la alternativa
    // tampoco puede tener un cuándo-NO para esta ocasión (el ranking penaliza pero no filtra) —
    // sin candidata válida, mejor la variante sin alternativa que auto-contradecirse.
    const candidatos = await searchCatalog(tenantId, { texto: text, limit: 3 });
    const alternativa = candidatos.find((c) => c.id !== producto!.id && veredictoOcasion(c, ocasion) !== 'no_conviene') ?? null;
    return {
      tipo: 'respuesta',
      result: {
        reply: respuestaOcasionNoConviene(producto, ocasion, alternativa),
        nextState: 'VIEWING_PRODUCT',
        // La oferta pendiente es la ALTERNATIVA: el próximo "sí" agrega lo que se ofreció.
        pendingCart: alternativa
          ? buildPendingConfirmation([{ id: alternativa.id, name: alternativa.name }], 'catalog_listing', prev.nowMs)
          : null,
        lastShownSkus: alternativa ? [alternativa.id] : [],
      },
    };
  }

  return {
    tipo: 'respuesta',
    result: {
      reply: respuestaOcasionConviene(producto, ocasion),
      nextState: 'VIEWING_PRODUCT',
      pendingCart: buildPendingConfirmation([{ id: producto.id, name: producto.name }], 'catalog_listing', prev.nowMs),
      lastShownSkus: [producto.id],
    },
  };
}

/**
 * ADR-0015 §8: productos "en juego" en el turno y su deriva. Sin adivinar y sin lecturas de más:
 *  - el producto que NOMBRA el mensaje (solo si el texto trae tokens de entidad — un "hola" no
 *    dispara un escaneo del catálogo),
 *  - los del carrito cuando el turno es de carrito/agregado (formatear el carrito AFIRMA precios),
 *  - los de la oferta vigente cuando el cliente la está respondiendo (un "sí" agrega y anuncia un
 *    total: eso también es afirmar un precio).
 * Devuelve el veredicto SANEADO (ids, campos y estado; jamás valores remotos). Pura salvo la
 * lectura del catálogo y de la proyección. Exportada para tests.
 */
export async function evaluarDerivaDelTurno(
  tenantId: string,
  text: string,
  t: string,
  prev: { cart: Cart; pending: PendingCartConfirmation | null },
): Promise<VeredictoDeriva> {
  // Gate BARATO primero: un tenant sin campos comerciales gobernados por una fuente externa no
  // paga ni una lectura de catálogo por este guard.
  if (!(await derivaActivaPara(tenantId))) return SIN_DERIVA;
  const enJuego = new Map<string, string>();
  if (quiereVerCarrito(t) || quiereAgregar(t)) {
    for (const i of prev.cart.items) enJuego.set(i.productId, i.name);
  }
  for (const p of prev.pending?.products ?? []) enJuego.set(p.id, p.name);
  if (queryTokens(text).length > 0) {
    const nombrado = await findProductByName(tenantId, text);
    if (nombrado) enJuego.set(nombrado.id, nombrado.name);
  }
  if (enJuego.size === 0) return SIN_DERIVA;
  return leerDeriva(tenantId, [...enJuego].map(([id, name]) => ({ id, name })));
}

export async function handleMessage(input: ConversationInput): Promise<ConversationResult> {
  const { tenantId, from, text } = input;
  const channel: MessageChannel = input.channel ?? 'whatsapp';
  const customerId = customerIdFromPhone(from);
  if (!customerId) {
    throw new Error('Teléfono inválido (sin dígitos)');
  }

  const now = Timestamp.now();
  /**
   * ADR-0017 §2 — el canal del turno se normaliza UNA sola vez y de acá sale TODO: el documento
   * de sesión que se lee, el que se escribe y el que reciben los guards que el motor delega. Con
   * el default resuelto en cada callsite, alcanzaba con olvidarse uno para que ese pedazo del
   * turno operara sobre la conversación de otro número.
   */
  const sessionKey = input.sessionKey ?? LEGACY_SESSION_KEY;
  const sessionRef = db().doc(paths.session(tenantId, customerId, sessionKey));
  const snap = await sessionRef.get();
  const existing = snap.exists ? (snap.data() as Session) : null;

  const humanTakeover = existing?.context?.humanTakeover ?? false;
  // Config del agente (editable desde el panel): on/off + saludo.
  const agentConfig = await getAgentConfig(tenantId);
  const botSilent = enSilencio(existing, agentConfig);

  /**
   * ADR-0016 §12 — UN solo lugar decide QUIÉN persiste la burbuja de salida del bot.
   *
   * Con el borde de envío diferido (`deferOutbound`: el camino real de WhatsApp) acá NO se
   * escribe nada; el outbound viaja como descriptor y lo persiste el borde recién DESPUÉS del
   * chequeo autoritativo de silencio y del POST. Así una respuesta suprimida —o rechazada por
   * Meta— no queda en el historial mintiéndole al vendedor sobre lo que el cliente vio.
   *
   * Sin diferir (simulador del panel, chat de prueba, dev) nadie envía nada: el motor sigue
   * siendo el que registra, con el comportamiento exacto de siempre.
   */
  const registrarSalida = async (
    texto: string,
    meta: { state: SessionState | null; humanTakeover: boolean; countUnread?: boolean },
    expectativa: ExpectativaDeSilencio = EXIGE_SILENCIO_LIBRE,
  ): Promise<OutboundDiferido | undefined> => {
    if (input.deferOutbound) return { ...meta, expectativa };
    await appendMessage(tenantId, customerId, {
      direction: 'out',
      author: 'bot',
      text: texto,
      state: meta.state,
      humanTakeover: meta.humanTakeover,
      ...(meta.countUnread === undefined ? {} : { countUnread: meta.countUnread }),
      channel,
      receivedVia: input.receivedByPhoneNumberId ?? null,
    });
    return undefined;
  };

  // COVERAGE-1B: turno mientras se espera la ubicación. La clasificación es PURA y corre ANTES
  // de persistir el inbound: si el texto ES una dirección, el historial recibe SOLO el
  // placeholder (la dirección exacta va al coverageRequest, jamás a messages). Los interceptores
  // PREVIOS conservan la prioridad (review): un pedido de humano o un reclamo que además parezca
  // dirección se trata como 'otro' — su texto real queda en el historial y su flujo responde.
  const coveragePtr: CoverageSessionPointer | null = existing?.context?.coverage ?? null;
  // 1C: también clasificamos DURANTE la revisión (takeover coverage_review de este request):
  // una dirección nueva se registra en el request y el historial recibe SOLO el placeholder —
  // la dirección cruda jamás queda en messages ni llega a la IA en turnos posteriores (review).
  // El vendedor la ve completa en la tarjeta de revisión del panel.
  const enRevisionCobertura =
    humanTakeover &&
    existing?.context?.handoffReason === 'coverage_review' &&
    coveragePtr?.status === 'pending_coverage_review' &&
    existing?.context?.handoffSourceId === coveragePtr.requestId;
  const clasifBase =
    (!botSilent && coveragePtr?.status === 'awaiting_location') || enRevisionCobertura
      ? clasificarTextoEnEspera(text)
      : null;
  const clasifCobertura: typeof clasifBase =
    clasifBase && clasifBase !== 'otro' && (esPosiblePedidoHumano(text) || tipoReclamoCarrito(text) !== null)
      ? 'otro'
      : clasifBase;

  // Guardar SIEMPRE el mensaje entrante del cliente (incluso si el bot está en pausa).
  // EXCEPCIÓN (ADR-0016 §9): si el turno es el caption de un adjunto, la burbuja ya existe —la
  // creó la ingesta con el marcador del sistema y el puntero al archivo— y el caption NO puede
  // quedar como texto de un mensaje: el historial de la IA sale de acá.
  if (!input.attachmentCaption) {
    await appendMessage(tenantId, customerId, {
      direction: 'in',
      author: 'customer',
      text: clasifCobertura === 'direccion' ? '📍 Dirección recibida' : text,
      now,
      state: existing?.state ?? null,
      humanTakeover,
      countUnread: botSilent, // si el bot no atiende, el vendedor tiene algo pendiente
      channel,
      receivedVia: input.receivedByPhoneNumberId ?? null,
    });
  }

  // Tracking propio (P11): si el mensaje trae un código/cupón, atribuir la venta a esa fuente.
  try { await captureTrackingCode(tenantId, customerId, text); } catch { /* no crítico */ }

  // Atención humana: si un vendedor tomó el chat, el bot NO responde.
  if (humanTakeover) {
    // COVERAGE-1C: en revisión de cobertura (takeover coverage_review de ESTE request), una
    // nueva dirección escrita ACTUALIZA el request pendiente (transaccional) — el bot sigue
    // mudo; el historial guardó el placeholder y la dirección vive SOLO en el request (el
    // vendedor la ve en la tarjeta del panel).
    if (enRevisionCobertura && input.simulation !== true && clasifCobertura === 'direccion') {
      await actualizarUbicacionEnRevision(tenantId, customerId, text, input.messageId ?? null, sessionKey);
    }
    await sessionRef.set({ context: { lastMessageAt: now }, updatedAt: now }, { merge: true });
    logger.info('Mensaje en modo atención humana (bot en pausa)', { tenantId, customerId });
    return { reply: '', state: existing?.state ?? 'IDLE', handledByHuman: true };
  }

  // Bot apagado desde el panel → sin respuesta.
  if (!agentConfig.botEnabled) {
    await sessionRef.set({ context: { lastMessageAt: now }, updatedAt: now }, { merge: true });
    logger.info('Bot apagado por configuración — sin respuesta', { tenantId, customerId });
    return { reply: '', state: existing?.state ?? 'IDLE', handledByHuman: true };
  }

  const esNuevo = !existing || existing.state === 'GREETING';
  // F6: primer mensaje CON intención ("Hola, tenés Supremacy?") → se procesa la intención y se
  // antepone la bienvenida breve. La sesión creada en este turno es el flag anti-repetición.
  const nuevoConIntencion = esNuevo && !esSaludoPuro(text);
  const prevCart: Cart = existing?.cart ?? { items: [], subtotal: 0 };
  const prevShown: string[] = existing?.context?.lastShownSkus ?? [];

  // F3: oferta de carrito pendiente. La vencida se filtra ACÁ (contexto viejo nunca agrega) y se
  // limpia al escribir la sesión. `pendingExpirada` deja que una confirmación repregunte.
  const nowMs = now.toMillis();
  const pendingPrev = existing?.context?.pendingCartConfirmation ?? null;
  const pendingActivo = pendingVigente(pendingPrev, nowMs) ? pendingPrev : null;
  const pendingExpirada = !!pendingPrev && !pendingActivo;

  // F1: la IA recibe HISTORIAL (últimos AI_HISTORY_MAX mensajes, el inbound actual ya está
  // persistido por el appendMessage de arriba). Lazy: solo se lee si algún camino delega.
  const delegarAlSalesAgent = async (): ReturnType<typeof runSalesAgent> => {
    // ADR-0016 §9: «El caption se sanea y se persiste, pero no se envía a la IA». Este turno lo
    // trae un archivo ⇒ ni el caption ni el historial van al modelo. Se reusa `feature_unavailable`
    // (la IA no participa de este turno) y NO `quota_exhausted`, que dispara derivación a humano.
    if (input.attachmentCaption) {
      logger.info('Turno de adjunto: la IA no participa (ADR-0016 §9)', { tenantId });
      return { used: false, reason: 'feature_unavailable' };
    }
    const historial = await listRecentMessages(tenantId, customerId, AI_HISTORY_MAX);
    // ADR-0018: la clave de facturación es el wamid del inbound — los reintentos del webhook
    // re-entran con la misma clave y comparten UNA reserva (jamás doble cobro). Sin wamid
    // (simulador/dev) el agente genera una clave efímera.
    return runSalesAgent({
      tenantId, agentConfig, messages: buildAiHistory(historial, text),
      billingKey: input.messageId ? `ventas-${input.messageId}` : null,
    });
  };

  // F3: la IA mostró productos → la oferta es LO QUE EL TEXTO PRESENTA (alineado), no el orden
  // crudo del buscador (bug Odyssey/Supremacy). Si el texto no nombra ninguno, orden de la tool.
  const resultadoDesdeIA = (
    ai: { reply: string; shownProducts: Array<{ id: string; name: string }> },
    fallbackState: SessionState,
  ): Awaited<ReturnType<typeof decidirRespuesta>> => {
    if (ai.shownProducts.length === 0) return { reply: ai.reply, nextState: fallbackState }; // no pisa oferta previa
    const presentados = alignPresentedWithReply(ai.reply, ai.shownProducts);
    const oferta = presentados.length > 0 ? presentados : ai.shownProducts;
    return {
      reply: ai.reply,
      nextState: 'VIEWING_PRODUCT',
      lastShownSkus: oferta.map((p) => p.id),
      pendingCart: buildPendingConfirmation(oferta, 'ai_recommendation', nowMs),
    };
  };

  // F3: negativa ante la oferta vigente — determinística, sin IA:
  //  - rechazo puro ("no", "ese no") → no agregar, limpiar la oferta, cierre amable.
  //  - pide alternativa ("mejor otro", "tenés otro") → limpiar la oferta y seguir el ruteo
  //    normal (la IA/catálogo ofrecen otras opciones sobre contexto limpio).
  const negativa = !esNuevo && pendingActivo ? tipoNegativa(text) : null;
  const limpiarOfertaEnEscritura = negativa === 'alternativa';

  // F2/F3: una respuesta a la oferta vigente (confirmación corta, índice, intención de agregar o
  // la ELECCIÓN por nombre de un candidato) es parte del flujo de conversión → SIEMPRE reglas,
  // nunca la IA (que no puede escribir el carrito y no debe prometer acciones). Las PREGUNTAS
  // con número ("¿cuánto sale el 2?") y las opiniones que solo mencionan al candidato ("me
  // encanta el supremacy pero está caro") NO son respuesta a la oferta: van a la IA.
  const t = text.toLowerCase();
  const respondeOferta =
    !!pendingActivo &&
    (esConfirmacionCorta(text) ||
      (ordinalIndex(t) !== null && !esPreguntaConsulta(text)) ||
      quiereAgregar(t) ||
      eleccionPorNombre(text, pendingActivo.products).length > 0);
  const confirmandoSeleccion =
    respondeOferta ||
    (esConfirmacionCorta(text) && existing?.state === 'VIEWING_PRODUCT' && prevShown.length > 0);

  // Ruteo (AG-3): la cola conversacional (lo que el motor mandaría a su fallback) va al sales agent
  // de Claude — ADVISORY, solo info pública, sin tocar carrito/pedido. El resto (saludo, catálogo,
  // carrito, pagar, selección) se queda en las reglas. Si la IA está off/sin cupo/falla → fallback.
  let result: Awaited<ReturnType<typeof decidirRespuesta>> | undefined;
  if (negativa === 'rechazo') {
    result = {
      reply: 'Dale 👍 no lo agrego. Si querés, contame qué estilo buscás o escribí *catálogo* y vemos otras opciones.',
      nextState: existing?.state ?? 'BROWSING',
      pendingCart: null,
    };
  }
  // HANDOFF-2: el cliente PIDE una persona ("quiero hablar con un vendedor / con [nombre]") →
  // transición REAL server-side ANTES de la IA (que en prod prometió "un segundo que lo llamo"
  // sin poder ejecutar nada). La confirmación sale recién DESPUÉS de persistir el takeover.
  if (!result && esPosiblePedidoHumano(text)) {
    const hr = await procesarPedidoHumano(tenantId, customerId, text, { messageId: input.messageId ?? null, sessionKey });
    if (hr.handled && hr.takeover) {
      // §12: es la confirmación del takeover que ESTE turno acaba de persistir (sourceId = wamid,
      // el mismo que usó `procesarPedidoHumano`) ⇒ el borde la deja salir salvo takeover ajeno.
      const outbound = hr.reply.trim()
        ? await registrarSalida(
            hr.reply,
            {
              state: existing?.state ?? 'IDLE',
              humanTakeover: true,
              // El vendedor tiene algo pendiente: el badge de "sin leer" de /conversations es la
              // señal operativa del handoff (la campana avisa al owner).
              countUnread: true,
            },
            { modo: 'confirma_handoff_propio', sourceId: input.messageId ?? null },
          )
        : undefined;
      // El estado del handoff ya quedó persistido por el servicio canónico: acá NO se pisa la
      // sesión (el tail genérico escribiría humanTakeover=false del snapshot previo).
      logger.info('Handoff por pedido del cliente', { tenantId, customer: `…${customerId.slice(-4)}`, reason: 'customer_requested' });
      return { reply: hr.reply, state: existing?.state ?? 'IDLE', ...(outbound ? { outbound } : {}) };
    }
    if (hr.handled) {
      // Honestidad sin transición (nombre desconocido/inactivo/ambiguo/sin vendedores): sigue
      // el flujo normal de sesión — jamás se promete un pase que no persistió.
      result = { reply: hr.reply, nextState: existing?.state ?? 'BROWSING' };
    }
  }
  // F4 (anti-mentiras): un RECLAMO del cliente se responde desde el MOTOR con el estado real
  // del carrito — nunca desde la IA (que en prod inventó "Ya lo agregué" con el carrito vacío).
  // F6: el gate espeja al de la IA — un reclamo como PRIMER mensaje ("Hola, yo quería el X que
  // te pedí") también lo responde el interceptor determinístico, jamás la IA (review F6).
  const reclamo = (!esNuevo || nuevoConIntencion) && !result ? tipoReclamoCarrito(text) : null;
  if (reclamo) {
    const r = await interceptarReclamoCarrito(
      tenantId,
      text,
      { cart: prevCart, pendingVigente: pendingActivo, nowMs, enPago: existing?.state === 'AWAITING_PAYMENT' },
      reclamo,
    );
    if (r) {
      result = r;
      // Con deriva el interceptor no responde el estado del carrito: lo loguea el bloque de abajo.
      if (!r.driftBlock) logger.info('Reclamo de carrito → respuesta determinística con estado real', { tenantId, customerId, tipo: reclamo });
    }
  }
  // COVERAGE-1B: request `awaiting_location` vigente → dirección escrita, cancelación, "¿cómo
  // comparto?" y texto ambiguo se resuelven acá, SIN IA. Lo clasificado 'otro' (producto,
  // carrito, pagar, vendedor, reclamos, comprobantes, preguntas) sigue su flujo normal.
  if (!result && clasifCobertura && clasifCobertura !== 'otro') {
    const ce = await manejarTurnoEnEsperaUbicacion(tenantId, customerId, text, clasifCobertura, {
      messageId: input.messageId ?? null,
      simulation: input.simulation === true,
      channel,
      sessionKey,
    });
    if (ce?.takeover) {
      // El takeover coverage_review ya quedó persistido: NO se pisa la sesión (mismo criterio
      // que HANDOFF-2) y la confirmación sale recién después de persistir.
      if (ce.reply.trim()) {
        let replyCe = ce.reply;
        if (nuevoConIntencion) replyCe = saludoBreve(agentConfig.greetingMessage) + '\n\n' + sinSaludoInicial(replyCe);
        // §12: confirmación del takeover `coverage_review` que este turno persistió. Su sourceId
        // es el requestId (NO el wamid), igual que el que escribió la transición canónica.
        const outbound = await registrarSalida(
          replyCe,
          { state: existing?.state ?? 'IDLE', humanTakeover: true, countUnread: true },
          { modo: 'confirma_handoff_propio', sourceId: ce.handoffSourceId ?? null },
        );
        // KILL-SWITCH-1: la confirmación de revisión se etiqueta — process.ts re-lee el flag antes de mandarla.
        return { reply: replyCe, state: existing?.state ?? 'IDLE', ...(ce.coverageActivationId !== undefined ? { coverageActivationId: ce.coverageActivationId } : {}), ...(outbound ? { outbound } : {}) };
      }
      return { reply: '', state: existing?.state ?? 'IDLE', handledByHuman: true };
    }
    if (ce) {
      result = {
        reply: ce.reply,
        nextState: existing?.state ?? 'CART',
        ...(ce.coverage !== undefined ? { coverage: ce.coverage } : {}),
        ...(ce.locationRequest ? { locationRequest: true } : {}),
        ...(ce.coverageActivationId !== undefined ? { coverageActivationId: ce.coverageActivationId } : {}),
      };
    } else if (clasifCobertura === 'direccion') {
      // El texto ES una dirección pero el flujo ya no aplica (flag apagado a mitad / request
      // desaparecido): JAMÁS sigue al flujo normal — la dirección cruda no debe llegar a la IA
      // (el historial ya guardó solo el placeholder). Se limpia el puntero y se responde honesto.
      result = {
        reply: 'No pude procesar tu dirección automáticamente 🙏 Contame qué estás buscando o escribí *catálogo*.',
        nextState: existing?.state ?? 'BROWSING',
        coverage: null,
      };
    }
  }
  // CAT-2B: "¿PRODUCTO sirve para OCASIÓN?" → el MOTOR responde honesto con la ficha (cuándo-NO
  // gana; alternativa del ranking como oferta). Sin señal en la ficha → se DELEGA a la IA aunque
  // quiereCatalogo capture el texto: estas preguntas jamás vuelven al listado genérico (bug prod).
  let delegarPreguntaProducto = false;
  // Review CAT-2B: en AWAITING_PAYMENT no se intercepta — colgar una oferta acá rompería el
  // estado de pago (invariante F4: en pago no se ofrece re-agregar); la IA/reglas lo atienden.
  if (!result && (!esNuevo || nuevoConIntencion) && !confirmandoSeleccion && existing?.state !== 'AWAITING_PAYMENT') {
    const po = await interceptarPreguntaProductoOcasion(tenantId, text, t, {
      pendingVigente: pendingActivo,
      lastShownSkus: prevShown,
      nowMs,
    });
    if (po?.tipo === 'respuesta') {
      result = po.result;
      if (!po.result.driftBlock) logger.info('Pregunta producto+ocasión → respuesta determinística por ficha', { tenantId, customerId });
    } else if (po?.tipo === 'delegar') {
      delegarPreguntaProducto = true;
    }
  }
  // COVERAGE-GUARD-1: consultas de cobertura/costo/plazo de envío → respuesta SEGURA determinística,
  // jamás la IA (que extrapolaba la FAQ genérica de envíos a cobertura geográfica — hallazgo del
  // smoke de AI-FALLBACK). No deriva solo: si el cliente pide una persona, HANDOFF-2 hace el pase
  // real. El flujo de conversión GANA (review): un turno de pagar/agregar jamás se intercepta
  // ("¿me mandan el QR para pagar?" es checkout F5, no cobertura). pendingCart null: la invitación
  // "decime que querés hablar con un vendedor" convierte un "sí" posterior en pedido de contacto,
  // no en confirmación de la oferta vieja (mismo criterio que el fallback de IA no disponible).
  if (!result && (!esNuevo || nuevoConIntencion) && !confirmandoSeleccion && !quierePagar(t) && !quiereAgregar(t) && esConsultaCobertura(text)) {
    result = { reply: RESPUESTA_COBERTURA_SEGURA, nextState: existing?.state ?? 'BROWSING', pendingCart: null };
    logger.info('Consulta de cobertura → respuesta segura determinística (sin IA)', { tenantId, customer: `…${customerId.slice(-4)}` });
  }
  // DRIFT-GUARD (ADR-0015 §8): un producto cuyo precio/disponibilidad/stock público gobierna una
  // fuente externa que HOY dice otra cosa no se afirma como confirmado. Ubicación DELIBERADA:
  //  - DESPUÉS de todos los guards que ya existían (pedido de humano, reclamo de carrito, cobertura
  //    en espera de ubicación, producto+ocasión y consulta de cobertura): ninguno pierde su turno;
  //  - ANTES de la IA: un turno que igual se deriva no gasta una llamada al modelo;
  //  - con el camino de pago PURO excluido: ese es del checkout (reuse → cobertura → orden), donde
  //    el freno fail-closed vive en createPendingOrder, en la rama de reuso y en la reanudación por
  //    cobertura del vendedor;
  //  - en AWAITING_PAYMENT sigue mandando el flujo de pago/comprobante (mismo criterio CAT-2B),
  //    CON UNA excepción: la VISTA DE CARRITO. El gate por estado dejaba pasar un caso concreto —
  //    el cliente que ya pidió pagar y después escribe "carrito" recibía `formatCart`, o sea el
  //    detalle por ítem Y el total, AFIRMANDO justo el precio que no podemos sostener. Ese turno no
  //    pertenece al flujo de pago (no manda banco, no toca la orden, no lee un comprobante) y todo
  //    el que SÍ le pertenece —pagar, comprobante, cobertura, reclamo, pedido de humano— ya retornó
  //    o ya tiene su interceptor ANTES de esta línea: cubrirlo no le roba el turno a nadie.
  // El filtro de vendibilidad no se mueve: esto no hace ofrecible nada que hoy no lo sea.
  //
  // POR QUÉ la exclusión NO puede mirar `quierePagar` sola (hallazgo del review de cierre): la
  // condición del guard tiene que seguir la MISMA precedencia que `decidirRespuesta`, y ahí la
  // VISTA DE CARRITO (paso 2) se atiende ANTES que el checkout (paso 3). Un solo mensaje dispara
  // las dos intenciones —"quiero pagar mi pedido", "pagar, qué llevo?", "quiero comprar, mostrame
  // mi carrito", "dale pago mi compra"— y ese turno NO termina en el checkout: termina en
  // `formatCart`, con el detalle por ítem y el total, afirmando como confirmado justo el precio en
  // deriva e invitando a cerrar. Es la intersección de intenciones, no un estado de sesión: pasaba
  // en CART igual que en AWAITING_PAYMENT. Solo se excluye el pago PURO, que es el único que
  // realmente llega al checkout.
  const vistaDeCarrito = quiereVerCarrito(t);
  const pagoPuro = quierePagar(t) && !vistaDeCarrito;
  if (
    !result &&
    driftGuardCableado() &&
    (!esNuevo || nuevoConIntencion) &&
    !pagoPuro &&
    (existing?.state !== 'AWAITING_PAYMENT' || vistaDeCarrito)
  ) {
    const veredicto = await evaluarDerivaDelTurno(tenantId, text, t, {
      cart: prevCart,
      pending: respondeOferta ? pendingActivo : null,
    });
    if (veredicto.bloqueantes.length) {
      // Se conserva el estado actual: el pase a humano lo ejecuta el bloque de derivación de abajo.
      result = { reply: '', nextState: existing?.state ?? 'BROWSING', driftBlock: veredicto };
      logger.info('Deriva crítica del catálogo → el bot no cotiza y deriva', {
        tenantId,
        customer: `…${customerId.slice(-4)}`,
        ...resumenSaneado(veredicto),
      });
    } else if (veredicto.advertencias.length) {
      // Divergencia COSMÉTICA (nombre, mayúsculas, descripción, imagen): advertencia
      // administrativa. No cambia una sola palabra de lo que lee el cliente.
      logger.warn('Deriva cosmética del catálogo (no corta la conversación)', {
        tenantId,
        customer: `…${customerId.slice(-4)}`,
        productos: veredicto.advertencias.length,
        campos: [...new Set(veredicto.advertencias.flatMap((a) => a.fields))].sort(),
      });
    }
  }
  if (!result && (!esNuevo || nuevoConIntencion) && !confirmandoSeleccion && (delegarPreguntaProducto || ruleEngineWouldFallback(text, t))) {
    const ai = await delegarAlSalesAgent();
    if (ai.used) {
      // Ids/nombres SOLO del backend de buscar_productos (nunca del texto del modelo).
      result = resultadoDesdeIA(ai, existing?.state ?? 'BROWSING');
      logger.info('Respuesta por sales agent IA', { tenantId, customerId, shown: ai.shownProducts.length, tools: ai.usedTools.length });
    } else if (ai.reason === 'quota_exhausted' && esConsultaDerivable(text)) {
      // AI-FALLBACK-HONESTO-1: la consulta NECESITABA IA y la cuota/presupuesto está agotado →
      // derivación REAL al vendedor (servicio canónico de HANDOFF-2, razón ai_unavailable) en
      // vez del fallback genérico. SOLO cuota agotada deriva: errores transitorios, config
      // faltante o respuestas vacías siguen al fallback rule-based (no convertimos un parpadeo
      // del proveedor en takeover). El rescate de catálogo vacío también queda fuera: ahí las
      // reglas SÍ resuelven con su canned honesto.
      const fb = await derivarPorIaNoDisponible(tenantId, customerId, {
        messageId: input.messageId ?? null,
        simulation: input.simulation === true,
        sessionKey,
      });
      if (fb.takeover && !input.simulation) {
        // Primer mensaje con intención (F6): misma bienvenida breve que el resto de los caminos.
        let replyFb = fb.reply;
        if (nuevoConIntencion && replyFb.trim()) {
          replyFb = saludoBreve(agentConfig.greetingMessage) + '\n\n' + sinSaludoInicial(replyFb);
        }
        // §12: confirmación del takeover `ai_unavailable` recién persistido (sourceId = wamid).
        const outbound = replyFb.trim()
          ? await registrarSalida(
              replyFb,
              { state: existing?.state ?? 'IDLE', humanTakeover: true, countUnread: true },
              { modo: 'confirma_handoff_propio', sourceId: input.messageId ?? null },
            )
          : undefined;
        logger.info('IA no disponible → derivado a humano', { tenantId, customer: `…${customerId.slice(-4)}` });
        return { reply: replyFb, state: existing?.state ?? 'IDLE', ...(outbound ? { outbound } : {}) };
      }
      // Simulación (sin efectos) o sin vendedor/persistencia: sigue el flujo normal de sesión.
      // pendingCart se limpia: la conversación cambió de tema hacia "atención humana" (review).
      result = { reply: fb.reply, nextState: existing?.state ?? 'BROWSING', pendingCart: null };
    } else if (delegarPreguntaProducto) {
      // La IA no corrió (gate/cupo/falla) y era una pregunta sobre un producto: canned honesto,
      // NUNCA el listado genérico del catálogo (guard CAT-2B).
      result = {
        reply:
          'No tengo ese dato confirmado de este producto 🙏 ¿Querés que te muestre otras opciones, ' +
          'o preferís que te ayude una persona del equipo?',
        nextState: existing?.state ?? 'BROWSING',
        pendingCart: null,
      };
      logger.info('Pregunta producto sin señal y sin IA → canned honesto (sin listado)', { tenantId, customerId });
    }
  }
  if (!result) {
    result = await decidirRespuesta(tenantId, customerId, text, esNuevo, {
      cart: prevCart,
      lastShownSkus: prevShown,
      greeting: agentConfig.greetingMessage,
      profitMode: agentConfig.profitMode,
      state: existing?.state ?? null,
      pendingCart: pendingActivo,
      pendingExpirada,
      pendingOrderId: existing?.context?.pendingOrderId ?? null,
      nowMs,
      coverageTurno: {
        messageId: input.messageId ?? null,
        simulation: input.simulation === true,
        channel,
        receivedVia: input.receivedByPhoneNumberId ?? null,
        sessionKey,
      },
    });
    // F1: catálogo sin resultados → antes del canned "no encontré", intentar la IA (sus tools
    // buscan con mejores parámetros y puede ofrecer alternativas reales). Si la IA no corre
    // (gate/disabled/error), queda el canned de siempre. OJO (F6): también alcanzable con
    // esNuevo cuando el primer mensaje trae intención de catálogo (existing puede ser null).
    if (result.catalogEmpty) {
      const ai = await delegarAlSalesAgent();
      if (ai.used) {
        result = resultadoDesdeIA(ai, result.nextState);
        logger.info('Catálogo vacío → respuesta por sales agent IA', { tenantId, customerId, shown: ai.shownProducts.length, tools: ai.usedTools.length });
      }
    }
  }
  // ADR-0015 §8: deriva CRÍTICA (venga del guard conversacional o del freno del checkout) →
  // transición REAL por el servicio canónico HANDOFF-2 con razón estructurada `catalog_drift` y
  // aviso idempotente. La confirmación al cliente sale recién DESPUÉS de que el takeover persistió;
  // el carrito y la conversación quedan intactos y no se cobra ni se promete nada.
  if (result.driftBlock) {
    const d = await derivarPorDerivaCritica(tenantId, customerId, result.driftBlock, {
      messageId: input.messageId ?? null,
      simulation: input.simulation === true,
      sessionKey,
    });
    if (d.takeover && !input.simulation) {
      // El estado del handoff ya quedó persistido por el servicio canónico: NO se pisa la sesión
      // (el tail genérico escribiría humanTakeover=false del snapshot previo).
      let replyD = d.reply;
      if (nuevoConIntencion && replyD.trim()) {
        replyD = saludoBreve(agentConfig.greetingMessage) + '\n\n' + sinSaludoInicial(replyD);
      }
      // §12: confirmación del takeover `catalog_drift` recién persistido. Su sourceId es la
      // DERIVA (`deriva-{ids}`), no el wamid: lo devuelve el servicio que ejecutó la transición.
      const outbound = replyD.trim()
        ? await registrarSalida(
            replyD,
            { state: existing?.state ?? 'IDLE', humanTakeover: true, countUnread: true },
            { modo: 'confirma_handoff_propio', sourceId: d.handoffSourceId ?? null },
          )
        : undefined;
      logger.info('Deriva de catálogo → derivado a humano', { tenantId, customer: `…${customerId.slice(-4)}` });
      return { reply: replyD, state: existing?.state ?? 'IDLE', ...(outbound ? { outbound } : {}) };
    }
    // Simulación (cero efectos) o sin vendedor/persistencia: sigue el flujo normal de sesión con
    // el mismo mensaje honesto — jamás se cotiza el precio en disputa por este camino.
    result = { ...result, reply: d.reply, driftBlock: undefined };
  }

  const { nextState } = result;
  let reply = result.reply;
  // F6: primer mensaje con intención → bienvenida BREVE + la respuesta a la intención, en el
  // mismo turno (nunca la bienvenida completa duplicada: el próximo turno ya no es esNuevo).
  if (nuevoConIntencion && reply.trim()) {
    // sinSaludoInicial: la IA suele espejar el "Hola" del cliente — sin esto salía doble saludo.
    reply = saludoBreve(agentConfig.greetingMessage) + '\n\n' + sinSaludoInicial(reply);
  }

  const session: Session = {
    // El id del documento y el campo tienen que decir lo mismo. Un `'active'` hardcodeado adentro
    // de `sessions/wa_…` hace que cualquier lector que confíe en el campo —el panel, una
    // auditoría, un job que re-derive el path desde el documento— termine operando sobre la
    // conversación del número que HOY vende. Mismo molde que `handoff.ts`.
    id: sessionKey,
    tenantId,
    customerId,
    state: nextState,
    cart: result.cart ?? prevCart,
    context: {
      lastMessageAt: now,
      currentPage: existing?.context?.currentPage ?? 0,
      currentCategoryId: existing?.context?.currentCategoryId ?? null,
      // F5: tri-estado (string=nueva / null=limpiar / undefined=conservar) — sin el null, un
      // puntero a una orden ya pagada quedaba stale para siempre y bloqueaba el checkout.
      // 1D (review): el "conservar" se re-resuelve contra la lectura FRESCA dentro del tail —
      // este valor es provisional (ver la transacción de abajo).
      pendingOrderId: result.pendingOrderId !== undefined ? result.pendingOrderId : (existing?.context?.pendingOrderId ?? null),
      pendingPaymentId: existing?.context?.pendingPaymentId ?? null,
      // F3: al vencer la oferta se limpia TAMBIÉN lastShownSkus — si sobreviviera, un "el 1"
      // posterior resolvería contra una lista vieja/desalineada (el bug original de nuevo).
      lastShownSkus: result.lastShownSkus ?? (pendingExpirada ? [] : prevShown),
      humanTakeover: existing?.context?.humanTakeover ?? false,
      // F3: tri-estado del motor (objeto=nueva oferta / null=limpiar / undefined=conservar);
      // la vencida o descartada por negativa se limpia acá — nunca sobrevive contexto viejo.
      pendingCartConfirmation:
        result.pendingCart !== undefined
          ? result.pendingCart
          : limpiarOfertaEnEscritura || pendingExpirada
            ? null
            : (pendingPrev ?? null),
    },
    expiresAt: Timestamp.fromMillis(now.toMillis() + SESSION_TTL_MS),
    updatedAt: now,
  };

  // Asegurar que el cliente existe (mínimo) + guardar sesión
  await db()
    .doc(paths.customer(tenantId, customerId))
    .set({ id: customerId, tenantId, whatsappPhone: from, updatedAt: now }, { merge: true });
  // HANDOFF-2 (review): escritura TRANSACCIONAL con re-chequeo fresco — un turno lento en vuelo
  // (p.ej. IA de varios segundos) no puede PISAR un takeover que se persistió mientras tanto
  // (pedido de humano / comprobante / panel). Si un humano tomó el chat en el medio, este turno
  // no escribe la sesión NI responde: la promesa de pausa al cliente se cumple siempre.
  //
  // ADR-0016 §12: esto NO es el guard de silencio, y por eso mira solo `humanTakeover`. Acá se
  // protege la ESCRITURA de la sesión contra una carrera de escritura; la autoridad sobre si la
  // respuesta SALE es el guard del borde de envío (`evaluarSilencioPreEnvio`), que corre después
  // y sí aplica la regla completa —incluido el bot apagado desde el panel—.
  const tomadoEnElMedio = await db().runTransaction(async (tx) => {
    const fresh = await tx.get(sessionRef);
    const ctxFresh = (fresh.data()?.context ?? {}) as Session['context'];
    if (fresh.exists && ctxFresh.humanTakeover === true) {
      tx.set(sessionRef, { context: { lastMessageAt: now }, updatedAt: now }, { merge: true });
      return true;
    }
    // COVERAGE-1B: el puntero de cobertura se preserva desde la lectura FRESCA (no del snapshot
    // del inicio del turno). Si el propio turno trae un puntero (gate) pero el fresco apunta al
    // MISMO request con un update más nuevo (una ubicación concurrente ya lo avanzó), gana el
    // fresco — jamás se retrocede un pending_coverage_review a awaiting_location (review).
    const fresco = ctxFresh.coverage ?? null;
    const propio = result.coverage;
    const coverageFinal =
      propio === undefined
        ? fresco
        : propio && fresco && fresco.requestId === propio.requestId && fresco.updatedAt.toMillis() > propio.updatedAt.toMillis()
          ? fresco
          : propio;
    tx.set(sessionRef, {
      ...session,
      context: {
        ...session.context,
        coverage: coverageFinal,
        // 1D: la marca de reanudación-en-curso la escribe SOLO el worker — siempre del fresco.
        coverageResumeInProgress: ctxFresh.coverageResumeInProgress ?? null,
        // 1D (review): "conservar" el pendingOrderId se resuelve FRESCO — un turno lento en
        // vuelo no borra el puntero que el worker de reanudación fijó mientras tanto.
        pendingOrderId:
          result.pendingOrderId !== undefined ? result.pendingOrderId : (ctxFresh.pendingOrderId ?? null),
      },
    });
    return false;
  });
  if (tomadoEnElMedio) {
    logger.info('Turno en vuelo descartado: un humano tomó el chat en el medio', { tenantId, customer: `…${customerId.slice(-4)}` });
    return { reply: '', state: existing?.state ?? 'IDLE', handledByHuman: true };
  }

  // Guardar la respuesta del bot en el historial (sale por el mismo número que recibió).
  // §12: es una respuesta AUTÓNOMA del bot ⇒ exige silencio libre en el borde de envío.
  const outbound = reply.trim()
    ? await registrarSalida(reply, { state: nextState, humanTakeover: false })
    : undefined;

  logger.info('Mensaje procesado', { tenantId, customerId, state: nextState });
  return {
    reply,
    state: nextState,
    ...(result.locationRequest ? { locationRequest: true } : {}),
    ...(result.coverageActivationId !== undefined ? { coverageActivationId: result.coverageActivationId } : {}),
    ...(outbound ? { outbound } : {}),
  };
}
