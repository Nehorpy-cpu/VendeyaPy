/**
 * meta/historyCoordinator.ts — El coordinador DURABLE del historial (ADR-0017 §5)
 * ================================================================================
 * ETAPA D. Existe por una sola cita del contrato oficial, verificada el 2026-08-04:
 *
 *   «Esto se puede hacer una sola vez. Si hace falta repetirlo, el cliente tiene que offboardear
 *    primero y volver a completar el Embedded Signup.»
 *
 * De ahí sale TODO el diseño de este archivo, y ninguna de las tres consecuencias es opcional:
 *
 *  · **No hay reintento.** Un disparo perdido no se recupera con un botón: se recupera
 *    desconectando el número real del negocio y rehaciendo el flujo entero, sobre un número con
 *    clientes vivos. Por eso el estado es un documento de Firestore y no una variable de una
 *    invocación, y por eso el segundo disparo se rechaza DICIENDO POR QUÉ.
 *  · **La ventana de 24 h corre desde el ONBOARDING, no desde el disparo.** Un coordinador que no
 *    persista el deadline no puede distinguir «sigue llegando» de «se venció».
 *  · **«No compartió» es un desenlace explícito** (`history[0].errors[0].code = 2593109`), no un
 *    silencio. Sin leerlo el sistema espera hasta quemar la ventana.
 *
 * Y LA REGLA QUE GOBIERNA LA COMPLETITUD: un fallo de persistencia NO puede quedar reconocido como
 * «completado». El coordinador prefiere decir `failed` sobre algo que quizás llegó entero, antes
 * que decir `completed` sobre un import parcial: lo primero hace que un humano mire, lo segundo
 * hace que nadie mire nunca.
 *
 * NO GUARDA PII. Ni un wa_id, ni un texto, ni un teléfono: contadores, estados y marcas de tiempo.
 * El contenido vive en `metaWebhookHistory`, que es `read: if false` y tiene TTL.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';

/**
 * Subcolección del coordinador. Va por TENANT y por PNID: dos números del mismo tenant tienen
 * ventanas, decisiones y desenlaces independientes.
 *
 * El nombre vive acá y no en `paths.*` por lo mismo que las colecciones de Coexistence en
 * `webhookHttp.ts`: `lib/firebase.ts` lo está tocando otra superficie de este programa. Mudarlo
 * cuando las ramas se junten.
 */
export const coexistenceHistorySyncPath = (tenantId: string, phoneNumberId: string): string =>
  `tenants/${tenantId}/coexistenceHistorySyncs/${phoneNumberId}`;

/**
 * Estados del ciclo. Los seis del ADR más `pending_request`, que es el que hace posible la regla
 * «una sola vez»: sin un estado explícito para «el humano ya decidió pero todavía no se disparó»,
 * el disparo no tiene contra qué reclamar y dos invocaciones concurrentes disparan las dos.
 * `declined` cubre los dos desenlaces de «no se compartió»: el que decidió el negocio en su app
 * (código 2593109) y el que decidimos nosotros al elegir no compartir.
 */
export const HISTORY_SYNC_STATUS = Object.freeze([
  'pending_request',
  'requested',
  'receiving',
  'completed',
  'declined',
  'expired',
  'failed',
] as const);
export type HistorySyncStatus = (typeof HISTORY_SYNC_STATUS)[number];

/** La decisión HUMANA, explícita y previa al disparo. */
export const HISTORY_SHARING_DECISIONS = Object.freeze(['share', 'skip'] as const);
export type HistorySharingDecision = (typeof HISTORY_SHARING_DECISIONS)[number];

/** Meta da 24 h desde el ONBOARDING. Pasadas, hay que offboardear y rehacer el Embedded Signup. */
export const HISTORY_SYNC_WINDOW_MS = 24 * 3_600_000;

/**
 * Tope de claves de chunk que se guardan para deduplicar. Por encima manda el contador: un
 * documento de Firestore no pasa 1 MiB, y perder el coordinador entero por guardar claves sería
 * peor que perder la exactitud del conteo. Cuando se supera queda declarado en `observadosTruncado`.
 */
export const HISTORY_SYNC_MAX_KEYS = 400;

export interface HistorySyncDoc {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  connectionId: string;
  status: HistorySyncStatus;
  /**
   * Generación de la sincronización. Una SEGUNDA sincronización sólo existe tras offboardear y
   * rehacer el Embedded Signup, y trae los MISMOS `phase`/`chunk_order` que la primera: sin la
   * generación en la clave de idempotencia del webhook, el resync entero se descartaría como
   * duplicado. Arranca en 1 (que conserva la clave histórica, sin sufijo).
   */
  syncGeneration: number;
  sharingDecision: HistorySharingDecision | null;
  decidedByUid: string | null;
  decidedAt: Timestamp | null;
  /** Arranque de la ventana de 24 h. `null` si el coordinador nació desde el webhook. */
  onboardedAt: Timestamp | null;
  deadlineAt: Timestamp | null;
  requestedAt: Timestamp | null;
  /** Qué `sync_type` se llegaron a pedir, en orden. Evidencia de hasta dónde llegó el disparo. */
  syncTypesRequested: string[];
  chunksObservados: string[];
  observadosTruncado: boolean;
  chunksObservadosCount: number;
  chunksDuplicados: number;
  /** Claves de chunks cuya PERSISTENCIA falló y todavía no volvieron a llegar. */
  chunksFallidosPendientes: string[];
  /** Chunks que llegaron sin poder resolver el tenant. Pegajoso: no se puede verificar aislamiento. */
  chunksSinTenant: number;
  /** Chunks sin fase/orden que no se pudieron persistir. Pegajoso: no tienen clave para recuperarse. */
  fallosSinClave: number;
  mediaObservados: number;
  /** Máximo `metadata.progress` visto. Máximo y no último: los chunks llegan REORDENADOS. */
  maxProgress: number | null;
  lastChunkAt: Timestamp | null;
  declineCode: number | null;
  errorMessage: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Clave estable de un chunk dentro de una generación. Sin fase ni orden no hay clave posible. */
export function chunkKey(phase: number | null, chunkOrder: number | null): string | null {
  return phase !== null && chunkOrder !== null ? `p${phase}c${chunkOrder}` : null;
}

/** Lo que el webhook OBSERVÓ de un chunk. `nuevo` distingue el primer arribo de una redelivery. */
export interface ChunkObservado {
  phase: number | null;
  chunkOrder: number | null;
  progress: number | null;
  /** false ⇒ el documento ya existía (reintento de Meta). Sigue contando como observado. */
  nuevo: boolean;
  /** false ⇒ la escritura del archivo FALLÓ. Nunca puede terminar en `completed`. */
  persistido: boolean;
  /** false ⇒ no se pudo resolver el tenant del chunk: el aislamiento no es verificable. */
  tenantResuelto: boolean;
  /** El chunk trae `errors[].code = 2593109`: el negocio no compartió. */
  declinado: boolean;
  declineCode?: number | null;
}

// ---------------------------------------------------------------------------
// Decisiones PURAS (sin Firestore, sin reloj) — donde vive la lógica que importa
// ---------------------------------------------------------------------------

export type MotivoDeRechazo = 'sin_coordinador' | 'sin_decision' | 'no_compartir' | 'ya_disparado' | 'vencido';

export interface VeredictoDeDisparo {
  puede: boolean;
  motivo?: MotivoDeRechazo;
  /** Explicación en castellano, pensada para que un humano entienda qué hacer. */
  explicacion: string;
}

/**
 * ¿Se puede disparar `smb_app_data` sobre este coordinador AHORA?
 *
 * Es la función más importante del archivo: dice que NO en los cuatro casos en que decir que sí
 * cuesta el onboarding entero de un número con clientes vivos. Y dice POR QUÉ, porque el operador
 * que reciba el rechazo tiene que poder distinguir «falta decidir» de «ya se usó el único disparo».
 */
export function puedeDisparar(coord: Partial<HistorySyncDoc> | null | undefined, nowMs: number): VeredictoDeDisparo {
  if (!coord) {
    return { puede: false, motivo: 'sin_coordinador', explicacion: 'No hay una decisión registrada para este número: primero hay que decidir explícitamente si se comparte el historial.' };
  }
  if (coord.sharingDecision === 'skip') {
    return { puede: false, motivo: 'no_compartir', explicacion: 'Se decidió NO compartir el historial de este número. Esa decisión es terminal: para revertirla hay que offboardear el número y rehacer el Embedded Signup.' };
  }
  if (coord.sharingDecision !== 'share') {
    return { puede: false, motivo: 'sin_decision', explicacion: 'Falta la decisión humana explícita de compartir el historial. La opción segura por defecto es no compartir.' };
  }
  if (coord.status !== 'pending_request') {
    return {
      puede: false,
      motivo: 'ya_disparado',
      explicacion: `La sincronización de este número ya se pidió (estado: ${coord.status ?? 'desconocido'}). Meta permite pedirla UNA sola vez: repetirla exige que el cliente offboardee el número y vuelva a completar el Embedded Signup.`,
    };
  }
  const deadlineMs = coord.deadlineAt ? coord.deadlineAt.toMillis() : null;
  if (deadlineMs !== null && nowMs > deadlineMs) {
    return { puede: false, motivo: 'vencido', explicacion: 'Se venció la ventana de 24 h que da Meta desde el onboarding. Ya no se puede pedir el historial de este número sin rehacer el flujo.' };
  }
  return { puede: true, explicacion: 'La decisión humana está registrada, la ventana sigue abierta y el disparo todavía no se usó.' };
}

/** Estados de los que ya no se sale: pedir de nuevo no es una opción que exista. */
const TERMINALES: readonly HistorySyncStatus[] = Object.freeze(['completed', 'declined', 'expired', 'failed']);

export function esEstadoTerminal(status: HistorySyncStatus | undefined | null): boolean {
  return status !== undefined && status !== null && TERMINALES.includes(status);
}

/** Acumulado de una tanda de observaciones sobre el estado previo. Puro: se testea sin emulador. */
export interface EstadoAcumulado {
  status: HistorySyncStatus;
  chunksObservados: string[];
  observadosTruncado: boolean;
  chunksObservadosCount: number;
  chunksDuplicados: number;
  chunksFallidosPendientes: string[];
  chunksSinTenant: number;
  /**
   * Chunks SIN fase ni orden cuya persistencia falló. No tienen clave, así que no se puede saber
   * si el reintento de Meta los trajo de vuelta: el contador no baja nunca, y por eso impide
   * `completed` para siempre. Es la traducción honesta de «no puedo afirmar que llegó entero».
   */
  fallosSinClave: number;
  maxProgress: number | null;
  declineCode: number | null;
  errorMessage: string;
}

/**
 * La aritmética del progreso. Tres invariantes, y las tres nacieron de un defecto concreto:
 *
 *  1. **Idempotente ante duplicados y reordenamientos**: se deduplica por CLAVE del chunk, no por
 *     orden de llegada ni por contador. Meta reenvía tandas enteras cuando el webhook no responde
 *     200, y los chunks no llegan en orden.
 *  2. **Un fallo de persistencia impide `completed`**: la clave queda en `chunksFallidosPendientes`
 *     hasta que ESE chunk vuelva a llegar y se persista. Si el progreso llega a 100 con fallos
 *     pendientes, el desenlace es `failed`, no `completed`.
 *  3. **Un chunk sin tenant resuelto también lo impide, y es PEGAJOSO**: el chunk quedó escrito sin
 *     empresa, así que su aislamiento no se puede verificar mirando el dato. Un reintento posterior
 *     no lo arregla —el documento ya existe y llega como duplicado—, así que el contador no baja.
 */
export function acumularObservaciones(
  previo: Partial<EstadoAcumulado> | null | undefined,
  observaciones: readonly ChunkObservado[],
): EstadoAcumulado {
  const previoStatus = previo?.status as HistorySyncStatus | undefined;
  const claves = new Set(previo?.chunksObservados ?? []);
  const fallidos = new Set(previo?.chunksFallidosPendientes ?? []);
  const estado: EstadoAcumulado = {
    status: previoStatus ?? 'receiving',
    chunksObservados: [...claves],
    observadosTruncado: previo?.observadosTruncado ?? false,
    chunksObservadosCount: previo?.chunksObservadosCount ?? 0,
    chunksDuplicados: previo?.chunksDuplicados ?? 0,
    chunksFallidosPendientes: [...fallidos],
    chunksSinTenant: previo?.chunksSinTenant ?? 0,
    fallosSinClave: previo?.fallosSinClave ?? 0,
    maxProgress: previo?.maxProgress ?? null,
    declineCode: previo?.declineCode ?? null,
    // El mensaje se DERIVA en cada pasada, no se arrastra: un `errorMessage` pegajoso hacía que un
    // chunk recuperado siguiera contando como falla y el import nunca pudiera cerrarse.
    errorMessage: '',
  };

  let declinado = false;
  for (const obs of observaciones) {
    if (obs.declinado) {
      declinado = true;
      estado.declineCode = obs.declineCode ?? estado.declineCode;
      continue; // el chunk de rechazo no trae progreso ni contenido: no cuenta como material
    }
    const clave = chunkKey(obs.phase, obs.chunkOrder);
    if (!obs.nuevo) estado.chunksDuplicados++;
    if (!obs.tenantResuelto) estado.chunksSinTenant++;

    if (clave === null) {
      // Sin clave no hay dedup posible. Se cuenta igual —el material existe— y se declara la
      // imprecisión: un chunk sin fase ni orden no puede sostener una afirmación de completitud.
      estado.chunksObservadosCount++;
      estado.observadosTruncado = true;
    } else if (!claves.has(clave)) {
      claves.add(clave);
      estado.chunksObservadosCount++;
      if (claves.size <= HISTORY_SYNC_MAX_KEYS) estado.chunksObservados.push(clave);
      else estado.observadosTruncado = true;
    }

    if (clave !== null) {
      if (!obs.persistido) fallidos.add(clave);
      else if (obs.nuevo) fallidos.delete(clave);
    } else if (!obs.persistido) {
      // Sin clave no se puede marcar «este volvió»: queda como falla permanente y visible.
      estado.fallosSinClave++;
    }

    if (obs.progress !== null && (estado.maxProgress === null || obs.progress > estado.maxProgress)) {
      estado.maxProgress = obs.progress;
    }
  }
  estado.chunksFallidosPendientes = [...fallidos];

  // Los desenlaces terminales NO se revierten por material que llegue después: un rechazo o un
  // vencimiento describen algo que ya pasó, y pisarlos con un `completed` sería borrar el motivo
  // por el que alguien tiene que mirar.
  if (declinado || previoStatus === 'declined') {
    estado.status = 'declined';
    estado.errorMessage = 'el negocio eligió no compartir el historial';
    return estado;
  }
  if (previoStatus === 'expired') {
    estado.status = 'expired';
    estado.errorMessage = 'venció la ventana de 24 h';
    return estado;
  }

  const completo = estado.maxProgress !== null && estado.maxProgress >= 100;
  if (estado.chunksFallidosPendientes.length > 0) estado.errorMessage = 'hay chunks del historial que no se pudieron persistir';
  else if (estado.fallosSinClave > 0) estado.errorMessage = 'un chunk sin fase/orden no se pudo persistir y no se puede verificar que haya vuelto';
  else if (estado.chunksSinTenant > 0) estado.errorMessage = 'hay chunks del historial que quedaron sin empresa resuelta';

  if (completo && estado.errorMessage === '') {
    estado.status = 'completed';
  } else if (completo) {
    // NUNCA `completed` sobre un import que no se puede afirmar entero. Es la dirección
    // conservadora a propósito: `failed` hace que alguien mire; `completed` hace que nadie mire.
    estado.status = 'failed';
    estado.errorMessage = `la sincronización llegó al 100 %, pero ${estado.errorMessage}`;
  } else {
    estado.status = 'receiving';
  }
  return estado;
}

/** ¿Se venció la ventana sin desenlace? Puro, para que lo apliquen el webhook y el panel igual. */
export function vencido(coord: Pick<HistorySyncDoc, 'status' | 'deadlineAt'>, nowMs: number): boolean {
  if (esEstadoTerminal(coord.status)) return false;
  const deadlineMs = coord.deadlineAt ? coord.deadlineAt.toMillis() : null;
  return deadlineMs !== null && nowMs > deadlineMs;
}

// ---------------------------------------------------------------------------
// E/S — todo transaccional: el estado del coordinador es la única defensa del disparo único
// ---------------------------------------------------------------------------

export async function leerCoordinador(tenantId: string, phoneNumberId: string): Promise<HistorySyncDoc | null> {
  const snap = await db().doc(coexistenceHistorySyncPath(tenantId, phoneNumberId)).get();
  return snap.exists ? (snap.data() as HistorySyncDoc) : null;
}

export type DecisionResultado =
  | { ok: true; status: HistorySyncStatus; syncGeneration: number; deadlineAtMs: number | null }
  | { ok: false; reason: 'ya_decidido'; explicacion: string };

/**
 * Registra la decisión HUMANA, EXPLÍCITA y PREVIA sobre el historial de un número.
 *
 * `skip` es terminal (`declined`) y no se revierte por acá: revertirla obliga a offboardear el
 * número y rehacer el Embedded Signup, así que fingir que un botón alcanza sería mentir.
 * `share` deja el coordinador en `pending_request`: sólo desde ahí se puede disparar.
 *
 * SI EL INGESTOR NO ESTÁ PROBADO, LA OPCIÓN SEGURA ES `skip` (ADR-0017 §4): es la única que no
 * apuesta la ventana de 24 h sobre un número con clientes vivos.
 */
export async function registrarDecisionDeHistorial(args: {
  tenantId: string;
  phoneNumberId: string;
  connectionId: string;
  decision: HistorySharingDecision;
  actorUid: string;
  /** Cuándo se completó el onboarding: arranque REAL de la ventana de 24 h (no el disparo). */
  onboardedAtMs: number;
  nowMs: number;
}): Promise<DecisionResultado> {
  const ref = db().doc(coexistenceHistorySyncPath(args.tenantId, args.phoneNumberId));
  return db().runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
    if (previo && previo.sharingDecision !== null && previo.sharingDecision !== undefined) {
      return {
        ok: false as const,
        reason: 'ya_decidido' as const,
        explicacion: `Ya hay una decisión registrada para este número (${previo.sharingDecision}, estado ${previo.status}). Cambiarla exige offboardear el número y rehacer el Embedded Signup.`,
      };
    }
    const now = Timestamp.fromMillis(args.nowMs);
    const status: HistorySyncStatus = args.decision === 'share' ? 'pending_request' : 'declined';
    // La generación arranca en 1 y sólo la mueve un ciclo nuevo (que hoy no existe sin
    // offboarding). Se persiste igual para que la clave de idempotencia del webhook la pueda leer.
    const syncGeneration = (previo?.syncGeneration ?? 0) + 1;
    const deadline = Timestamp.fromMillis(args.onboardedAtMs + HISTORY_SYNC_WINDOW_MS);
    const doc: HistorySyncDoc = {
      id: args.phoneNumberId,
      tenantId: args.tenantId,
      phoneNumberId: args.phoneNumberId,
      connectionId: args.connectionId,
      status,
      syncGeneration,
      sharingDecision: args.decision,
      decidedByUid: args.actorUid,
      decidedAt: now,
      onboardedAt: Timestamp.fromMillis(args.onboardedAtMs),
      deadlineAt: deadline,
      requestedAt: null,
      syncTypesRequested: [],
      chunksObservados: previo?.chunksObservados ?? [],
      observadosTruncado: previo?.observadosTruncado ?? false,
      chunksObservadosCount: previo?.chunksObservadosCount ?? 0,
      chunksDuplicados: previo?.chunksDuplicados ?? 0,
      chunksFallidosPendientes: previo?.chunksFallidosPendientes ?? [],
      chunksSinTenant: previo?.chunksSinTenant ?? 0,
      fallosSinClave: previo?.fallosSinClave ?? 0,
      mediaObservados: previo?.mediaObservados ?? 0,
      maxProgress: previo?.maxProgress ?? null,
      lastChunkAt: previo?.lastChunkAt ?? null,
      declineCode: null,
      errorMessage: args.decision === 'skip' ? 'se decidió no compartir el historial' : '',
      createdAt: previo?.createdAt ?? now,
      updatedAt: now,
    };
    tx.set(ref, doc, { merge: true });
    return { ok: true as const, status, syncGeneration, deadlineAtMs: deadline.toMillis() };
  });
}

export type ReclamoResultado =
  | { ok: true; syncGeneration: number }
  | { ok: false; motivo: MotivoDeRechazo; explicacion: string };

/**
 * RECLAMA el disparo ANTES de llamar a Meta. Es lo que hace que «una sola vez» sea cierto también
 * entre dos invocaciones concurrentes: la transacción mueve `pending_request` → `requested`, y la
 * segunda encuentra el estado ya movido y se rechaza sola.
 *
 * Reclamar antes de llamar significa que un disparo que falla en Graph NO se reintenta. Es
 * deliberado: no hay forma de saber si Meta lo recibió, y un segundo intento sobre uno que sí
 * llegó consume el único que existía.
 */
export async function reclamarDisparo(tenantId: string, phoneNumberId: string, nowMs: number): Promise<ReclamoResultado> {
  const ref = db().doc(coexistenceHistorySyncPath(tenantId, phoneNumberId));
  return db().runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
    const veredicto = puedeDisparar(previo ?? null, nowMs);
    if (!veredicto.puede) {
      if (veredicto.motivo === 'vencido' && previo) {
        tx.set(ref, { status: 'expired' satisfies HistorySyncStatus, errorMessage: 'venció la ventana de 24 h sin disparar', updatedAt: Timestamp.fromMillis(nowMs) }, { merge: true });
      }
      return { ok: false as const, motivo: veredicto.motivo!, explicacion: veredicto.explicacion };
    }
    tx.set(ref, { status: 'requested' satisfies HistorySyncStatus, requestedAt: Timestamp.fromMillis(nowMs), updatedAt: Timestamp.fromMillis(nowMs) }, { merge: true });
    return { ok: true as const, syncGeneration: previo?.syncGeneration ?? 1 };
  });
}

/** Cierra el disparo: qué `sync_type` se llegaron a pedir, y si alguno falló. */
export async function registrarResultadoDelDisparo(
  tenantId: string,
  phoneNumberId: string,
  resultado: { ok: boolean; syncTypes: readonly string[]; error?: string },
  nowMs: number,
): Promise<void> {
  const ref = db().doc(coexistenceHistorySyncPath(tenantId, phoneNumberId));
  await ref.set(
    {
      syncTypesRequested: [...resultado.syncTypes],
      ...(resultado.ok
        ? {}
        : {
            status: 'failed' satisfies HistorySyncStatus,
            // El texto explica la ÚNICA recuperación real: no hay reintento posible.
            errorMessage: `el disparo falló (${resultado.error ?? 'desconocido'}); no se puede reintentar: hay que offboardear el número y rehacer el Embedded Signup`,
          }),
      updatedAt: Timestamp.fromMillis(nowMs),
    },
    { merge: true },
  );
}

/**
 * Registra lo que llegó por webhook. Transaccional porque Meta manda tandas concurrentes y dos
 * lecturas-modificaciones-escrituras sueltas se pisan (y lo que se pierde es el contador que
 * decide si el import está completo).
 *
 * Crea el coordinador si no existe: un historial que llega sin coordinador es una anomalía que hay
 * que poder ver, y perder la evidencia sería peor que guardarla con el origen declarado.
 */
export async function registrarObservaciones(args: {
  tenantId: string;
  phoneNumberId: string;
  observaciones: readonly ChunkObservado[];
  mediaObservados?: number;
  nowMs: number;
}): Promise<void> {
  if (args.observaciones.length === 0 && !args.mediaObservados) return;
  const ref = db().doc(coexistenceHistorySyncPath(args.tenantId, args.phoneNumberId));
  try {
    await db().runTransaction(async (tx) => {
      const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
      const acumulado = acumularObservaciones(previo ?? null, args.observaciones);
      const now = Timestamp.fromMillis(args.nowMs);
      const status: HistorySyncStatus =
        acumulado.status === 'receiving' && previo && vencido({ status: acumulado.status, deadlineAt: previo.deadlineAt ?? null }, args.nowMs)
          ? 'expired'
          : acumulado.status;
      tx.set(
        ref,
        {
          id: args.phoneNumberId,
          tenantId: args.tenantId,
          phoneNumberId: args.phoneNumberId,
          ...(previo ? {} : { connectionId: '', syncGeneration: 1, sharingDecision: null, onboardedAt: null, deadlineAt: null, createdAt: now, errorMessage: 'llegó historial sin coordinador previo' }),
          status,
          chunksObservados: acumulado.chunksObservados,
          observadosTruncado: acumulado.observadosTruncado,
          chunksObservadosCount: acumulado.chunksObservadosCount,
          chunksDuplicados: acumulado.chunksDuplicados,
          chunksFallidosPendientes: acumulado.chunksFallidosPendientes,
          chunksSinTenant: acumulado.chunksSinTenant,
          fallosSinClave: acumulado.fallosSinClave,
          mediaObservados: (previo?.mediaObservados ?? 0) + (args.mediaObservados ?? 0),
          maxProgress: acumulado.maxProgress,
          declineCode: acumulado.declineCode,
          ...(acumulado.errorMessage ? { errorMessage: acumulado.errorMessage } : {}),
          lastChunkAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
    });
  } catch (e) {
    // El webhook ya decidió su código de respuesta por el resultado de la ESCRITURA del chunk: si
    // esto falla, el chunk igual está (o igual falló) y Meta reintenta. Se loguea sin el PNID.
    logger.error('historyCoordinator: no se pudo registrar el progreso del historial', e, { tenantId: args.tenantId });
  }
}
