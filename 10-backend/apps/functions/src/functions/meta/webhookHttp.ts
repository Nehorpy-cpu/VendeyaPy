/**
 * metaWebhook / devSimulateInbound — Entrada de mensajes de Meta (D2)
 * ==================================================================
 * metaWebhook: GET = handshake de verificación de Meta (ex-F1). POST = guarda el
 * evento crudo en la bandeja (metaWebhookInbox) y responde rápido; el trigger lo
 * procesa después (ADR-0009).
 * devSimulateInbound: simula un mensaje entrante (para probar sin Meta real).
 */

import { onRequest } from 'firebase-functions/v2/https';
import { Timestamp } from 'firebase-admin/firestore';
import type { WebhookEventKind, WebhookInboxEvent } from '@vpw/shared';
import { maskPhone } from '@vpw/shared';
import { db, paths } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import { verifyMetaSignature } from '../../middleware/webhookSignature.js';
import { guardDevEndpoint } from '../../middleware/devGuard.js';
import {
  echoIdempotencyKey,
  esHistorialNoCompartido,
  historyMediaIdempotencyKey,
  parseMetaWebhookPayload,
  HISTORY_NOT_SHARED_CODE,
} from '../../meta/parseWebhook.js';
import type { ParseResult } from '../../meta/parseWebhook.js';
import { aplicarAccountUpdate } from '../../meta/accountUpdate.js';
import { leerCoordinador, registrarObservaciones, type ChunkObservado } from '../../meta/historyCoordinator.js';

const TTL_MS = 30 * 86_400_000;

/**
 * COEXISTENCE (ADR-0017 §12) — DESTINOS SEPARADOS.
 * ================================================
 * `onWebhookInbox` dispara sobre TODO documento de `metaWebhookInbox`: esa colección **es** el
 * disparador del motor. Por eso el historial y la agenda del vendedor no pasan por ahí. La defensa
 * es doble a propósito —un gate por tipo de evento Y un destino separado— porque un `if` se puede
 * borrar en un refactor y una colección distinta no.
 *
 * Y hay una segunda razón, de aislamiento: `metaWebhookInbox` la lee `isPlatformAdmin()`. Mandar
 * ahí 180 días de chats privados del tenant convertiría esa regla en acceso de plataforma al
 * historial completo de sus clientes. Estas dos colecciones son `read: if false` en `firestore.rules`.
 *
 * PENDIENTE: los nombres viven acá y no en `paths.*` (`lib/firebase.ts`) porque ese archivo lo está
 * tocando otra superficie de este mismo programa. Mudarlos cuando las dos ramas se junten.
 */
export const COEXISTENCE_HISTORY_COLLECTION = 'metaWebhookHistory';
export const COEXISTENCE_APP_STATE_COLLECTION = 'metaWebhookAppState';

/**
 * TTL del historial: 48 h. Meta da 24 h para sincronizarlo y después hay que rehacer todo el
 * onboarding; 48 h deja un margen de un reintento completo y nada más. Es material sensible y su
 * lugar definitivo es la conversación, no esta bandeja.
 *
 * ATENCIÓN: escribir `expiresAt` NO es tener retención. La política TTL se declara en
 * `firestore.indexes.json` (`fieldOverrides`) y se aplica al desplegar índices; el barrido del
 * repo que ANULA el payload y borra lo vencido vive en `coexistenceRetention.ts`. Las dos cosas
 * existen a propósito: una política de consola que nadie aplicó no se nota hasta que hay 180 días
 * de conversaciones privadas guardadas para siempre.
 */
export const HISTORY_TTL_MS = 48 * 3_600_000;
/** TTL de contactos: 7 d. Es una agenda, no un registro: si nadie la consumió en una semana, sobra. */
export const APP_STATE_TTL_MS = 7 * 86_400_000;

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';
// Token del handshake de verificación (Meta). En prod: WHATSAPP_WEBHOOK_VERIFY_TOKEN.
const verifyToken = () => process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || (isEmulator() ? 'aiafg-verify-demo' : '');

// Id de inbox determinístico por (platform, clave) para idempotencia. Sanitiza
// caracteres no válidos de Firestore (p.ej. '/' en wamid base64).
const inboxDocId = (platform: string, messageId: string): string =>
  messageId ? `${platform}_${messageId}`.replace(/[^\w.:=+-]/g, '_').slice(0, 256) : '';

function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: number | string } | null)?.code;
  return code === 6 || code === 'already-exists' || /already.?exists/i.test(String(e));
}

function baseEvent(args: {
  id: string;
  platform: string;
  kind: WebhookEventKind;
  eventType: string;
  externalId: string;
  payload: unknown;
  nowMs: number;
  ttlMs: number;
  /**
   * Solo el ARCHIVO de Coexistence nace con tenant. Los eventos del inbox (`messages`, `echo`) lo
   * siguen dejando en null porque `process.ts` los resuelve al procesarlos, y adelantarlo acá
   * costaría una lectura por mensaje sobre el número que ya vende.
   */
  tenantId?: string | null;
}): WebhookInboxEvent {
  const now = Timestamp.fromMillis(args.nowMs);
  return {
    id: args.id, platform: args.platform, objectType: 'message', eventType: args.eventType,
    externalId: args.externalId, tenantId: args.tenantId ?? null, kind: args.kind,
    processingStatus: 'received', payload: args.payload, errorMessage: '', receivedAt: now, processedAt: null,
    expiresAt: Timestamp.fromMillis(args.nowMs + args.ttlMs),
  };
}

function inboxEvent(id: string, platform: string, externalId: string, payload: unknown): WebhookInboxEvent {
  return baseEvent({ id, platform, kind: 'message', eventType: 'messages', externalId, payload, nowMs: Date.now(), ttlMs: TTL_MS });
}

/** Una escritura ya DECIDIDA: qué colección, con qué id y con qué documento. */
export interface PlannedWebhookWrite {
  collection: string;
  /** null ⇒ id automático (solo cuando no hay ninguna clave de idempotencia posible). */
  docId: string | null;
  kind: WebhookEventKind;
  event: WebhookInboxEvent;
  /**
   * Presente SOLO en los chunks de historial: lo que el coordinador durable necesita saber de ese
   * chunk para decidir si la sincronización avanzó, se rechazó o quedó incompleta. `nuevo` y
   * `persistido` los completa el handler según cómo haya salido la escritura — el plan es puro.
   */
  observacion?: Omit<ChunkObservado, 'nuevo' | 'persistido'>;
}

/**
 * Sufijo de GENERACIÓN de la clave de idempotencia del archivo.
 *
 * DEFECTO AUDITADO: la clave era `history_{pnid}_{phase}_{chunkOrder}` y NO distingue una segunda
 * sincronización. Una segunda sólo existe tras offboardear el número y rehacer el Embedded Signup,
 * y trae exactamente los mismos `phase`/`chunk_order`: el resync entero se descartaría como
 * duplicado y el coordinador esperaría chunks que ya fueron «vistos».
 *
 * La generación 1 conserva la clave HISTÓRICA (sin sufijo): es retrocompatible con lo ya escrito y
 * no duplica documentos por un cambio de formato.
 */
const sufijoDeGeneracion = (generacion: number): string => (generacion > 1 ? `_g${generacion}` : '');

/**
 * Un duplicado NO significa lo mismo según el tipo. Un mensaje repetido es rutina de Meta
 * (reintentos) y no requiere atención. Un CHUNK DE HISTORIAL repetido sí: la ventana para
 * sincronizar es de 24 h y, pasada, hay que desconectar el número y rehacer todo el flujo — sobre
 * un número con clientes vivos. Un chunk que se traga con log `info` se descubre tarde.
 */
export function duplicatePolicy(kind: WebhookEventKind): { level: 'info' | 'warn'; counter: 'duplicates' | 'historyDuplicates' | 'appStateDuplicates' } {
  if (kind === 'history') return { level: 'warn', counter: 'historyDuplicates' };
  if (kind === 'app_state') return { level: 'warn', counter: 'appStateDuplicates' };
  return { level: 'info', counter: 'duplicates' };
}

/**
 * Traduce lo que devolvió el parser a la lista de escrituras. Es PURO —sin Firestore, sin reloj—
 * para que la decisión de destino se pueda probar sin emulador: es la decisión más cara de
 * equivocarse de toda esta superficie.
 *
 * Los campos DESCONOCIDOS no generan escritura a propósito: se auditan en el log (forma, no
 * contenido) y se responde 200. Persistir un payload que este despliegue no entiende sería guardar
 * material posiblemente sensible sin saber qué es ni cuánto dura.
 */
export function planWebhookWrites(
  parsed: ParseResult,
  nowMs: number,
  /**
   * Tenant YA resuelto por `externalId` (el `phone_number_id` receptor). Lo trae el llamador —y no
   * se lee acá— para que esta función siga siendo pura. Solo lo consumen las dos colecciones del
   * archivo: sin `tenantId` en el documento, el aislamiento por tenant de 180 días de chats
   * privados no se puede verificar mirando el dato, y una purga por empresa no tendría por dónde
   * agarrarlo.
   */
  tenantPorExternalId?: ReadonlyMap<string, string | null>,
  /**
   * Generación de la sincronización por PNID, leída del coordinador durable. Ausente ⇒ 1, que es
   * la clave histórica. Ver `sufijoDeGeneracion`.
   */
  generacionPorExternalId?: ReadonlyMap<string, number>,
): PlannedWebhookWrite[] {
  const writes: PlannedWebhookWrite[] = [];
  const tenantDe = (externalId: string): string | null => tenantPorExternalId?.get(externalId) ?? null;
  const generacionDe = (externalId: string): number => generacionPorExternalId?.get(externalId) ?? 1;

  for (const m of parsed.messages) {
    const payload = {
      from: m.from,
      text: m.text,
      messageId: m.messageId,
      timestamp: m.timestamp,
      ...(m.adReferral ? { adReferral: m.adReferral } : {}),
      // ADR-0016: adjunto genérico (imagen o PDF) ya saneado por el parser. El mediaId viaja
      // porque la descarga ocurre en el trigger; process.ts lo anula una vez guardado el archivo.
      ...(m.attachment ? { attachment: m.attachment } : {}),
      // Tipos aún no soportados (audio/video/sticker): viajan para dejar rastro en el chat.
      ...(m.unsupported ? { unsupported: m.unsupported } : {}),
      // COVERAGE-1B: ubicación nativa VALIDADA (tránsito hacia el trigger; process.ts la anula
      // del inbox al terminar — la ubicación exacta persiste SOLO en coverageRequests).
      ...(m.location ? { location: m.location } : {}),
      rawMessage: m.rawMessage, // mínimo para auditoría/debug; sin tokens ni secretos (location redactada)
    };
    const docId = inboxDocId(m.platform, m.messageId);
    writes.push({
      collection: paths.metaWebhookInbox(),
      docId: docId || null,
      kind: 'message',
      event: { ...baseEvent({ id: docId, platform: m.platform, kind: 'message', eventType: 'messages', externalId: m.externalId, payload, nowMs, ttlMs: TTL_MS }), automationEligible: true },
    });
  }

  for (const e of parsed.echoes) {
    // PAYLOAD NAMESPACEADO: el echo vive bajo `payload.echo.*` y NO existe `payload.from`. El guard
    // de `process.ts` exige `payload.from` para procesar un inbound, así que aunque alguien borrara
    // el gate por tipo, un echo seguiría sin poder convertirse en un mensaje del cliente. Es un
    // fail-safe pasivo: no depende de que nadie se olvide de mantener un `if`.
    const payload = {
      direction: 'outbound',
      origin: 'whatsapp_business_app',
      automationEligible: false,
      echo: {
        customerWaId: e.customerWaId,
        messageId: e.messageId,
        timestamp: e.timestamp,
        echoType: e.echoType,
        text: e.text,
        mediaKind: e.mediaKind,
        originalMessageId: e.originalMessageId,
      },
    };
    const docId = inboxDocId(e.platform, echoIdempotencyKey(e));
    writes.push({
      collection: paths.metaWebhookInbox(),
      docId,
      kind: 'echo',
      event: { ...baseEvent({ id: docId, platform: e.platform, kind: 'echo', eventType: 'smb_message_echoes', externalId: e.externalId, payload, nowMs, ttlMs: TTL_MS }), automationEligible: false },
    });
  }

  for (const c of parsed.historyChunks) {
    // Clave por (canal, generación, fase, chunk): es lo que identifica un chunk en la
    // sincronización de Meta. Sin fase ni orden no hay clave posible ⇒ id automático (mejor un
    // duplicado que perderlo: el historial no se puede volver a pedir).
    const generacion = generacionDe(c.externalId);
    const clave = c.phase !== null && c.chunkOrder !== null ? `history_${c.externalId}_${c.phase}_${c.chunkOrder}${sufijoDeGeneracion(generacion)}` : '';
    const docId = inboxDocId(c.platform, clave);
    const declinado = esHistorialNoCompartido(c);
    const tenantId = tenantDe(c.externalId);
    writes.push({
      collection: COEXISTENCE_HISTORY_COLLECTION,
      docId: docId || null,
      kind: 'history',
      event: {
        ...baseEvent({ id: docId, platform: c.platform, kind: 'history', eventType: 'history', externalId: c.externalId, payload: { history: c }, nowMs, ttlMs: HISTORY_TTL_MS, tenantId }),
        historical: true,
        automationEligible: false,
        unread: false,
      },
      observacion: {
        phase: c.phase,
        chunkOrder: c.chunkOrder,
        progress: c.progress,
        // La distinción que hace auditable el resultado: un chunk escrito sin empresa resuelta no
        // permite verificar el aislamiento por tenant, así que el coordinador no puede declarar
        // completo el import. Ese era el defecto fail-soft de `resolveTenantsDelArchivo`.
        tenantResuelto: tenantId !== null,
        declinado,
        declineCode: declinado ? HISTORY_NOT_SHARED_CODE : null,
      },
    });
  }

  // ADJUNTOS DEL HISTORIAL (`field:"history"` con `value.messages[]`). Van al MISMO archivo cerrado
  // y NUNCA al inbox: `onWebhookInbox` dispara sobre todo documento de la bandeja, y estos son
  // material histórico. Sus mediaId sólo viven 14 días y no se pueden volver a pedir.
  for (const m of parsed.historyMedia) {
    const docId = inboxDocId(m.platform, historyMediaIdempotencyKey(m, generacionDe(m.externalId)));
    writes.push({
      collection: COEXISTENCE_HISTORY_COLLECTION,
      docId: docId || null,
      kind: 'history',
      event: {
        ...baseEvent({ id: docId, platform: m.platform, kind: 'history', eventType: 'history_media', externalId: m.externalId, payload: { historyMedia: m }, nowMs, ttlMs: HISTORY_TTL_MS, tenantId: tenantDe(m.externalId) }),
        historical: true,
        automationEligible: false,
        unread: false,
      },
    });
  }

  for (const a of parsed.appStateChanges) {
    const clave = `appstate_${a.externalId}_${a.contactWaId}_${a.action}_${a.timestamp ?? 0}${sufijoDeGeneracion(generacionDe(a.externalId))}`;
    const docId = inboxDocId(a.platform, clave);
    writes.push({
      collection: COEXISTENCE_APP_STATE_COLLECTION,
      docId,
      kind: 'app_state',
      event: {
        ...baseEvent({ id: docId, platform: a.platform, kind: 'app_state', eventType: 'smb_app_state_sync', externalId: a.externalId, payload: { appState: a }, nowMs, ttlMs: APP_STATE_TTL_MS, tenantId: tenantDe(a.externalId) }),
        automationEligible: false,
        unread: false,
      },
    });
  }

  return writes;
}

/**
 * Resuelve el tenant de los eventos del ARCHIVO (historial y agenda) por `metaExternalIndex`, que
 * es el mismo índice que usa `process.ts` para el inbox.
 *
 * Tres decisiones que importan:
 *  1. Solo se miran `history` y `smb_app_state_sync`. Un webhook de `messages` —el 100 % del
 *     tráfico del número que hoy vende— no paga NI UNA lectura extra: la ruta caliente queda
 *     exactamente como estaba.
 *  2. Una lectura por PNID DISTINTO, no por chunk. Una sincronización de historial llega en
 *     tandas de chunks del mismo número.
 *  3. FAIL-SOFT: si el índice no resuelve o Firestore se cae, el chunk se escribe igual con
 *     `tenantId: null`. Meta da 24 h para sincronizar el historial y, pasadas, hay que desconectar
 *     el número y rehacer todo el onboarding sobre un número con clientes vivos: perder un chunk
 *     es peor que guardarlo sin etiquetar. La colección es `read: if false` y tiene TTL, así que
 *     un documento sin tenant no expone nada de más.
 */
export interface ResolucionDelArchivo {
  /** PNID → empresa (o `null` si el índice no resolvió). */
  tenants: Map<string, string | null>;
  /** PNID → generación de la sincronización, del coordinador durable. Ver `sufijoDeGeneracion`. */
  generaciones: Map<string, number>;
}

export async function resolveTenantsDelArchivo(parsed: ParseResult): Promise<ResolucionDelArchivo> {
  const tenants = new Map<string, string | null>();
  const generaciones = new Map<string, number>();
  const pendientes = new Set<string>();
  for (const c of parsed.historyChunks) if (c.externalId) pendientes.add(`${c.platform}_${c.externalId}`);
  for (const m of parsed.historyMedia) if (m.externalId) pendientes.add(`${m.platform}_${m.externalId}`);
  for (const a of parsed.appStateChanges) if (a.externalId) pendientes.add(`${a.platform}_${a.externalId}`);
  if (pendientes.size === 0) return { tenants, generaciones };

  for (const clave of pendientes) {
    const externalId = clave.slice(clave.indexOf('_') + 1);
    try {
      const snap = await db().doc(paths.metaExternalIndexEntry(clave)).get();
      const crudo = (snap.data() as { tenantId?: unknown } | undefined)?.tenantId;
      const tenantId = typeof crudo === 'string' && crudo !== '' ? crudo : null;
      tenants.set(externalId, tenantId);
      // La generación sólo se puede leer con el tenant resuelto (el coordinador vive bajo la
      // empresa). Sin él queda 1: la clave histórica, que es la que no rompe nada.
      if (tenantId) {
        const coord = await leerCoordinador(tenantId, externalId);
        if (coord?.syncGeneration && coord.syncGeneration > 1) generaciones.set(externalId, coord.syncGeneration);
      }
    } catch (e) {
      // Sin el PNID en el log: identifica al negocio. Solo el nombre del error.
      logger.warn('metaWebhook: no se pudo resolver la empresa del archivo de Coexistence', {
        error: e instanceof Error ? e.name : 'desconocido',
      });
      tenants.set(externalId, null);
    }
  }
  return { tenants, generaciones };
}

export const metaWebhook = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  // 1) Verificación (handshake de Meta) — token por entorno, no hardcodeado.
  if (req.method === 'GET') {
    const expected = verifyToken();
    if (req.query['hub.mode'] === 'subscribe' && expected && req.query['hub.verify_token'] === expected) {
      res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    } else {
      res.status(403).send('forbidden');
    }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }

  // 2) Verificación de FIRMA (X-Hub-Signature-256): impide que cualquiera inyecte eventos.
  //    Fuera del emulador la firma es OBLIGATORIA (fail-closed). En el emulador se omite para
  //    poder probar el webhook real localmente (la demo usa devSimulateInbound).
  if (!isEmulator()) {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      logger.error('metaWebhook: falta WHATSAPP_APP_SECRET; se rechaza por seguridad');
      res.status(401).json({ ok: false, error: 'not configured' });
      return;
    }
    try {
      verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), appSecret);
    } catch {
      logger.warn('metaWebhook: firma inválida, rechazado');
      res.status(401).json({ ok: false, error: 'invalid signature' });
      return;
    }
  }

  // 3) Parsear el payload REAL de Meta → un despachador por `change.field` decide el TIPO, y el
  //    plan decide el DESTINO. `messages` y `smb_message_echoes` van a metaWebhookInbox (marcados
  //    con su tipo); `history` y `smb_app_state_sync` a colecciones propias, porque onWebhookInbox
  //    dispara sobre todo doc del inbox. Idempotencia por clave determinística (.create() falla si
  //    ya existe → duplicado). El shape del payload de `messages` no cambió: process.ts lo lee igual.
  try {
    const parsed = parseMetaWebhookPayload(req.body);
    const nowMs = Date.now();
    const archivo = await resolveTenantsDelArchivo(parsed);
    const plan = planWebhookWrites(parsed, nowMs, archivo.tenants, archivo.generaciones);
    let written = 0;
    const dups = { duplicates: 0, historyDuplicates: 0, appStateDuplicates: 0 };
    /** Observaciones del historial agrupadas por (empresa, número) para el coordinador durable. */
    const observaciones = new Map<string, { tenantId: string; phoneNumberId: string; chunks: ChunkObservado[]; media: number }>();
    /** ¿Falló la persistencia de algún chunk del ARCHIVO? Decide el código de respuesta. */
    let archivoNoPersistido = false;
    const anotar = (tenantId: string | null, phoneNumberId: string): { chunks: ChunkObservado[]; media: number } | null => {
      // Sin empresa no hay coordinador que actualizar: ese chunk se recupera por el reintento de
      // Meta, no inventando un destino.
      if (!tenantId || !phoneNumberId) return null;
      const clave = `${tenantId}|${phoneNumberId}`;
      if (!observaciones.has(clave)) observaciones.set(clave, { tenantId, phoneNumberId, chunks: [], media: 0 });
      return observaciones.get(clave)!;
    };

    for (const w of plan) {
      const col = db().collection(w.collection);
      const ref = w.docId ? col.doc(w.docId) : col.doc();
      let nuevo = false;
      let persistido = false;
      try {
        await ref.create({ ...w.event, id: ref.id });
        written++;
        nuevo = true;
        persistido = true;
      } catch (e) {
        if (isAlreadyExists(e)) {
          const { level, counter } = duplicatePolicy(w.kind);
          dups[counter]++;
          persistido = true; // el documento EXISTE: un duplicado no es material perdido
          // Sin identificadores completos: el docId puede contener el wamid o el teléfono del contacto.
          logger[level]('metaWebhook: evento duplicado, ignorado', { kind: w.kind, collection: w.collection, docId: maskPhone(ref.id) });
        } else {
          // NO esconder otros errores como duplicados.
          logger.error('metaWebhook: no se pudo escribir el evento', e, { kind: w.kind, collection: w.collection });
          // El historial NO se puede volver a pedir: un chunk perdido acá se recupera únicamente
          // desconectando el número real y rehaciendo el Embedded Signup. Por eso su fallo cambia
          // el código de respuesta y deja que Meta reintente (ver el cierre del handler).
          if (w.collection === COEXISTENCE_HISTORY_COLLECTION) archivoNoPersistido = true;
        }
      }
      if (w.observacion) {
        const acumulador = anotar(w.event.tenantId, w.event.externalId);
        if (acumulador) acumulador.chunks.push({ ...w.observacion, nuevo, persistido });
      } else if (w.kind === 'history') {
        const acumulador = anotar(w.event.tenantId, w.event.externalId);
        if (acumulador && persistido) acumulador.media++;
      }
    }

    // Progreso DURABLE del historial. Va después de las escrituras porque necesita saber cómo
    // salió cada una: un chunk que no se persistió no puede contarse como material recibido.
    for (const grupo of observaciones.values()) {
      await registrarObservaciones({
        tenantId: grupo.tenantId,
        phoneNumberId: grupo.phoneNumberId,
        observaciones: grupo.chunks,
        mediaObservados: grupo.media,
        nowMs,
      });
    }

    // CICLO DE DESCONEXIÓN (ADR-0017 §6): un `ACCOUNT_OFFBOARDED` degrada ese PNID a `inactive`.
    // No toca el ruteo, ni el token, ni la selección — ver `accountUpdate.ts`.
    for (const u of parsed.accountUpdates) await aplicarAccountUpdate(u, nowMs);

    // ERRORES DEL CANAL. `131060` es ESPERADO tras el onboarding (primer mensaje de un usuario, o
    // un companion no soportado): va como `info` para no llenar la auditoría de ruido. Cualquier
    // otro código va como `warn`, que es justamente lo que el ruido escondía.
    for (const err of parsed.messageErrors) {
      const nivel = err.expected ? 'info' : 'warn';
      logger[nivel]('metaWebhook: error declarado por Meta en el canal de mensajes', { code: err.code, title: err.title, esperado: err.expected });
    }
    // Campo desconocido: ACK 200, auditoría SANEADA (nombre del campo y claves — nunca el
    // contenido) y cero automatización. Es `warn` porque significa que Meta manda algo que este
    // despliegue no sabe interpretar: hay que enterarse, no descubrirlo meses después.
    for (const u of parsed.unknownFields) {
      logger.warn('metaWebhook: campo de webhook DESCONOCIDO, sin procesar', {
        field: u.field, valueKeys: u.valueKeys, itemCount: u.itemCount, externalId: maskPhone(u.externalId),
      });
    }
    const resumen = {
      written, ...dups, ignored: parsed.ignored,
      echoes: parsed.echoes.length,
      historyChunks: parsed.historyChunks.length,
      historyMedia: parsed.historyMedia.length,
      appStateChanges: parsed.appStateChanges.length,
      accountUpdates: parsed.accountUpdates.length,
      messageErrors: parsed.messageErrors.length,
      unknownFields: parsed.unknownFields.length,
    };
    logger.info('metaWebhook recibido', resumen);
    // SEMÁNTICA DE REINTENTO DE META, aplicada SÓLO al archivo del historial. Un 200 le dice a Meta
    // «lo tengo»; para el resto del tráfico eso sigue siendo lo correcto (un mensaje perdido se
    // recupera de otras formas y un no-200 haría redelivery de TODO el canal del número que vende).
    // Pero un chunk de historial que no se pudo persistir no se recupera de ninguna forma: pedirlo
    // de nuevo exige que el cliente offboardee el número y rehaga el Embedded Signup. Ahí el
    // reintento de Meta es la única red que existe, y perderlo en silencio es lo prohibido.
    if (archivoNoPersistido) {
      logger.error('metaWebhook: un chunk del historial no se pudo persistir; se pide reintento a Meta');
      res.status(503).json({ ok: false, retry: true, ...resumen });
      return;
    }
    res.status(200).json({ ok: true, ...resumen });
  } catch (e) {
    logger.error('Error en metaWebhook', e);
    res.status(200).json({ ok: false }); // 200 igual: evita reintentos en loop de Meta
  }
});

export const devSimulateInbound = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  if (!guardDevEndpoint(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Usá POST' }); return; }
  const b = (req.body ?? {}) as { platform?: string; externalId?: string; from?: string; text?: string; adReferral?: unknown };
  try {
    const ref = db().collection(paths.metaWebhookInbox()).doc();
    const payload = { from: b.from, text: b.text, ...(b.adReferral ? { adReferral: b.adReferral } : {}) };
    await ref.set(inboxEvent(ref.id, b.platform ?? 'whatsapp', b.externalId ?? 'wa-595', payload));
    res.json({ ok: true, eventId: ref.id });
  } catch (e) {
    logger.error('Error en devSimulateInbound', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});
