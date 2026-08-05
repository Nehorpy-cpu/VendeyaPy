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
 * Archivo de una generación CERRADA. Vive en la misma subcolección, con el número de generación en
 * el id: la generación anterior permanece terminal e intacta —es la auditoría de qué pasó con el
 * historial de ese número— y NUNCA se borra ni se reescribe. El documento "vivo" sigue siendo el
 * del PNID pelado: la UI y el webhook no tienen que saber de generaciones para encontrarlo.
 */
export const archivoDeGeneracionPath = (tenantId: string, phoneNumberId: string, generation: number): string =>
  `tenants/${tenantId}/coexistenceHistorySyncs/${phoneNumberId}_gen${generation}`;

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
  /**
   * Identidad del onboarding que ABRIÓ esta generación: el claim transaccional del `code` del
   * Embedded Signup. Es lo que hace verdadera la regla «solo un nuevo signup habilita una
   * generación posterior»: un replay del MISMO claim devuelve lo mismo sin abrir otra, y un claim
   * que ya quedó en `claimsUsados` (de una generación archivada) no puede resetear la vigente.
   * `null` en generaciones anteriores a este mecanismo.
   */
  generationClaimId: string | null;
  /** Claims de generaciones ya archivadas de este número: un callback viejo se reconoce acá. */
  claimsUsados: string[];
  /**
   * true ⇒ la generación fue cerrada ADMINISTRATIVAMENTE (offboarding o superación por un nuevo
   * onboarding). Ese cierre es PEGAJOSO: material tardío no lo reabre — reabrirlo borraría el
   * motivo por el que alguien tiene que mirar. El `failed` «por fallo de persistencia» NO lleva
   * esta marca y sigue siendo recuperable si el chunk faltante vuelve a llegar — HASTA que un
   * offboarding lo selle: el sello no reescribe el desenlace, solo cierra la recepción (H6).
   */
  cierreAdministrativo: boolean;
  /** Chunks que llegaron con la generación cerrada o sin disparo usado: material de OTRO ciclo. */
  chunksFueraDeCiclo: number;
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
  // El SELLO manda sobre el estado: una generación cerrada administrativamente (offboarding, o
  // superada por un onboarding nuevo) no recibe más material, así que disparar contra ella gasta
  // el único pedido de la vida del número contra una recepción muerta.
  if (coord.cierreAdministrativo === true) {
    return {
      puede: false,
      motivo: 'ya_disparado',
      explicacion: 'La sincronización de este número está cerrada (el número fue desconectado o el ciclo fue superado por un onboarding nuevo). Pedir el historial acá no traería nada: hay que rehacer el Embedded Signup.',
    };
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
    /**
     * Una generación SELLADA o TERMINAL no se re-arma decidiendo (review final). Sin este gate, un
     * coordinador `failed` con `cierreAdministrativo` —el número fue offboardeado— aceptaba una
     * decisión nueva y REESCRIBÍA `status` a `pending_request`, contradiciendo el sello: desde ahí
     * `puedeDisparar` daba luz verde y el disparo único se consumía contra una recepción que ya
     * estaba cerrada (todo el material entrante cuenta como fuera de ciclo). El operador quedaba
     * con la ventana de 24 h quemada creyendo que había pedido el historial.
     */
    if (previo && (previo.cierreAdministrativo === true || esEstadoTerminal(previo.status))) {
      return {
        ok: false as const,
        reason: 'ya_decidido' as const,
        explicacion: 'La sincronización de este número está cerrada (el número fue desconectado o el ciclo terminó). Para volver a decidir hay que rehacer el Embedded Signup: eso abre un ciclo nuevo.',
      };
    }
    const now = Timestamp.fromMillis(args.nowMs);
    const status: HistorySyncStatus = args.decision === 'share' ? 'pending_request' : 'declined';
    // DECIDIR NO FABRICA GENERACIONES. La generación la mueve exclusivamente un onboarding
    // autorizado nuevo (`abrirNuevaGeneracion`, con el claim del code). El código anterior hacía
    // `(previo ?? 0) + 1`: decidir sobre un coordinador nacido de un chunk huérfano lo subía a 2
    // sin que existiera segundo onboarding, y partía la clave de idempotencia del webhook en dos.
    const syncGeneration = previo?.syncGeneration ?? 1;
    // La ventana de 24 h la fija el ONBOARDING, no la decisión: si la generación ya la trae (la
    // escribió `abrirNuevaGeneracion` en el re-onboarding), decidir no puede correrla.
    const onboardedAt = previo?.onboardedAt ?? Timestamp.fromMillis(args.onboardedAtMs);
    const deadline = previo?.deadlineAt ?? Timestamp.fromMillis(args.onboardedAtMs + HISTORY_SYNC_WINDOW_MS);
    const doc: HistorySyncDoc = {
      id: args.phoneNumberId,
      tenantId: args.tenantId,
      phoneNumberId: args.phoneNumberId,
      connectionId: args.connectionId,
      status,
      syncGeneration,
      generationClaimId: previo?.generationClaimId ?? null,
      claimsUsados: previo?.claimsUsados ?? [],
      cierreAdministrativo: previo?.cierreAdministrativo ?? false,
      chunksFueraDeCiclo: previo?.chunksFueraDeCiclo ?? 0,
      sharingDecision: args.decision,
      decidedByUid: args.actorUid,
      decidedAt: now,
      onboardedAt,
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

/**
 * Cierra el disparo: qué `sync_type` se llegaron a pedir, y si alguno falló.
 *
 * (correctivo H8) TRANSACCIONAL y CERCADO por generación: `generation` es la que devolvió
 * `reclamarDisparo`, y el settlement solo puede escribir sobre ESE ciclo. El merge ciego anterior
 * dejaba que una respuesta tardía de Graph —con un re-onboarding legítimo en el medio— cerrara o
 * fallara la generación N+1 recién abierta, matando su único disparo antes de que existiera. Si la
 * vigente ya es otra, no se escribe nada y queda rastro observable (sin PNID: identifica al negocio).
 */
export async function registrarResultadoDelDisparo(
  tenantId: string,
  phoneNumberId: string,
  /** La generación RECLAMADA en `reclamarDisparo`: la identidad del trabajo que se está cerrando. */
  generation: number,
  resultado: { ok: boolean; syncTypes: readonly string[]; error?: string },
  nowMs: number,
): Promise<void> {
  const ref = db().doc(coexistenceHistorySyncPath(tenantId, phoneNumberId));
  await db().runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
    const generacionVigente = previo?.syncGeneration ?? 1;
    if (generacionVigente !== generation) {
      logger.warn('historyCoordinator: settlement de un disparo de una generación superada, descartado', {
        tenantId, generacionReclamada: generation, generacionVigente,
      });
      return;
    }
    tx.set(
      ref,
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
  });
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
  /**
   * (correctivo H9) Generación que el WEBHOOK selló al PERSISTIR estos chunks — la misma del sufijo
   * de su clave de idempotencia. Si viene y NO coincide con la vigente, el material es reentrega de
   * OTRO ciclo: cuenta en `chunksFueraDeCiclo` y no gobierna el desenlace. Opcional a propósito:
   * sin etiqueta el comportamiento es el histórico, para no romper al llamador actual.
   */
  generacionEtiquetada?: number;
  /**
   * true ⇒ el webhook YA decidió, con la misma lectura del coordinador que eligió la clave `_fdc`,
   * que este material es de otro ciclo. Se respeta INCONDICIONALMENTE: re-derivarlo acá abriría una
   * carrera —entre aquella lectura y esta transacción puede commitear un `reclamarDisparo`— y el
   * material quedaría acumulado como si fuera del ciclo vigente.
   */
  materialDeOtraGeneracion?: boolean;
  nowMs: number;
}): Promise<void> {
  if (args.observaciones.length === 0 && !args.mediaObservados) return;
  const ref = db().doc(coexistenceHistorySyncPath(args.tenantId, args.phoneNumberId));
  try {
    await db().runTransaction(async (tx) => {
      const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
      const now = Timestamp.fromMillis(args.nowMs);
      /**
       * MATERIAL FUERA DE CICLO (correctivo, ALTO 10 / MEDIO 18 / H9). Tres casos en los que la
       * generación vigente NO es receptora de estos chunks, y dejarlos pasar la gobernaba con
       * material de OTRO ciclo:
       *  · cierre ADMINISTRATIVO (offboarding / superación): el cierre es pegajoso — reabrirlo a
       *    `receiving`/`completed` borraría el motivo por el que alguien tiene que mirar;
       *  · `pending_request` sin `requestedAt`: la generación nueva TODAVÍA no disparó, así que su
       *    historial no puede estar llegando — esto es reentrega tardía de la generación anterior,
       *    y moverle el estado quemaría el disparo único antes de usarse;
       *  · etiqueta de OTRA generación (H9): el webhook selló la generación al persistir el chunk;
       *    si no es la vigente, es reentrega de un ciclo anterior aunque la vigente esté
       *    recibiendo — sin este cerco, un chunk viejo al 100 % «completaba» la generación nueva.
       * El material queda contado (`chunksFueraDeCiclo`) y los chunks ya persistieron en su
       * colección con su clave: no se pierde nada, solo no gobierna.
       */
      const receptorCerrado =
        previo?.cierreAdministrativo === true ||
        (previo?.status === 'pending_request' && !previo?.requestedAt);
      const materialDeOtraGeneracion =
        previo !== undefined &&
        args.generacionEtiquetada !== undefined &&
        args.generacionEtiquetada !== (previo.syncGeneration ?? 1);
      if (previo && (receptorCerrado || materialDeOtraGeneracion)) {
        tx.set(
          ref,
          {
            chunksFueraDeCiclo: (previo.chunksFueraDeCiclo ?? 0) + args.observaciones.length + (args.mediaObservados ?? 0),
            lastChunkAt: now,
            updatedAt: now,
          },
          { merge: true },
        );
        return;
      }
      const acumulado = acumularObservaciones(previo ?? null, args.observaciones);
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
          ...(previo ? {} : { connectionId: '', syncGeneration: 1, generationClaimId: null, claimsUsados: [], cierreAdministrativo: false, chunksFueraDeCiclo: 0, sharingDecision: null, onboardedAt: null, deadlineAt: null, createdAt: now, errorMessage: 'llegó historial sin coordinador previo' }),
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

// ---------------------------------------------------------------------------
// Generaciones — el ciclo de vida que hace VERDADERA la recuperación prometida
// ---------------------------------------------------------------------------

/**
 * Reintenta una operación con backoff corto (correctivo, MEDIOs 15/19). Existe por UNA ventana
 * concreta: entre el claim del `code` (que es de un solo uso y no se libera) y la apertura de la
 * generación del historial, un fallo transitorio dejaba el re-onboarding VARADO — el claim
 * consumido, la generación sin abrir, y el retry del callable muerto en «autorización ya
 * utilizada». Tres intentos cubren la contención y los hipos; si igual falla, se lanza el ÚLTIMO
 * error para que el diagnóstico no se trague.
 */
export async function conReintentos<T>(fn: () => Promise<T>, intentos: number): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (i < intentos - 1) await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw ultimo;
}

/**
 * Cierra la generación vigente cuando Meta desconecta el número (`ACCOUNT_OFFBOARDED` /
 * `PARTNER_REMOVED`). Honesta en los dos sentidos: una sincronización en curso queda `failed` con
 * el motivo real —no `completed`, no borrada—, y una generación ya terminal conserva su desenlace
 * EXACTO (cerrar no es decidir, y offboardear no reescribe la historia). No inventa consentimiento:
 * `sharingDecision` no se toca.
 *
 * (correctivo H6) Pero conservar el desenlace NO es lo mismo que no escribir nada: el offboarding
 * SELLA todo estado que no esté sellado, incluso los terminales. El caso real es el `failed` por
 * fallo de persistencia, que por diseño sigue siendo receptor —el chunk faltante puede volver—;
 * retornar temprano sobre él dejaba la generación offboardeada reabrible a `receiving`/`completed`
 * por material tardío, borrando el motivo por el que alguien tenía que mirar.
 */
export async function cerrarGeneracionPorOffboarding(
  tenantId: string,
  phoneNumberId: string,
  nowMs: number,
  /**
   * Cuándo OCURRIÓ la desconexión, según Meta (ms). FENCE TEMPORAL: un `account_update` reentregado
   * tarde —o retomado tras un claim fallido— puede llegar DESPUÉS de que el cliente rehizo el
   * Embedded Signup. Sellar ahí mataría la generación N+1 recién abierta: su disparo único quedaría
   * quemado sin haberse usado, y la recuperación que el propio ADR promete sería imposible. Una
   * desconexión no puede ser noticia sobre una generación que nació después de ella.
   * `undefined` (Meta no garantiza el campo) ⇒ no se cerca: manda el fail-closed.
   */
  eventoOcurridoMs?: number,
): Promise<void> {
  const ref = db().doc(coexistenceHistorySyncPath(tenantId, phoneNumberId));
  await db().runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;
    if (!previo) return; // sin coordinador no hay nada que cerrar — y no se inventa uno
    if (previo.cierreAdministrativo === true) return; // ya sellada: el reintento es idempotente
    const nacioDespues =
      eventoOcurridoMs !== undefined &&
      previo.onboardedAt !== null &&
      previo.onboardedAt !== undefined &&
      previo.onboardedAt.toMillis() > eventoOcurridoMs;
    if (nacioDespues) {
      logger.info('historyCoordinator: la desconexión es anterior a la generación vigente; no la sella', { tenantId });
      return;
    }
    if (esEstadoTerminal(previo.status)) {
      // Terminal sin sello: el desenlace y su motivo quedan como estaban — solo gana el sello,
      // que es lo que cierra la recepción de material para siempre.
      tx.set(ref, { cierreAdministrativo: true, updatedAt: Timestamp.fromMillis(nowMs) }, { merge: true });
      return;
    }
    tx.set(
      ref,
      {
        status: 'failed' satisfies HistorySyncStatus,
        cierreAdministrativo: true,
        errorMessage: 'el número fue offboardeado por Meta; esta sincronización queda cerrada. Un nuevo Embedded Signup abre un ciclo nuevo.',
        updatedAt: Timestamp.fromMillis(nowMs),
      },
      { merge: true },
    );
  });
}

export type AperturaDeGeneracion =
  | { ok: true; syncGeneration: number; /** true = replay del mismo claim: no se abrió nada nuevo. */ reused: boolean }
  | { ok: false; reason: 'claim_superado'; explicacion: string };

/**
 * Abre la generación siguiente del historial tras un onboarding AUTORIZADO. La autorización no se
 * declara: se DEMUESTRA con el `claimId` — el reclamo transaccional del `code` del Embedded Signup,
 * que solo existe si un signup real acaba de completarse (un code no se puede reclamar dos veces).
 *
 *  · Mismo claim que la vigente ⇒ replay del callback: mismo resultado, cero escrituras.
 *  · Claim presente en `claimsUsados` ⇒ callback de una generación ya archivada llegando tarde:
 *    se rechaza y la vigente queda intacta. Un callback viejo no puede resetear una generación nueva.
 *  · Claim nuevo ⇒ la vigente se ARCHIVA íntegra en `{pnid}_gen{N}` (si no era terminal, primero se
 *    cierra `failed` de forma honesta: el re-onboarding demuestra que hubo un offboarding aunque el
 *    `account_update` nunca haya llegado) y nace la generación N+1: SIN decisión heredada —el
 *    consentimiento no se transfiere entre onboardings—, contadores a cero y ventana de 24 h nueva.
 *
 * Sin coordinador previo (primer onboarding) solo registra la generación 1 con su claim, para que
 * el replay y la ventana queden anclados desde el principio.
 */
export async function abrirNuevaGeneracion(args: {
  tenantId: string;
  phoneNumberId: string;
  connectionId: string;
  claimId: string;
  onboardedAtMs: number;
  nowMs: number;
}): Promise<AperturaDeGeneracion> {
  const ref = db().doc(coexistenceHistorySyncPath(args.tenantId, args.phoneNumberId));
  const now = Timestamp.fromMillis(args.nowMs);

  const generacionNueva = (previo: HistorySyncDoc | undefined): HistorySyncDoc => ({
    id: args.phoneNumberId,
    tenantId: args.tenantId,
    phoneNumberId: args.phoneNumberId,
    connectionId: args.connectionId,
    status: 'pending_request',
    syncGeneration: (previo?.syncGeneration ?? 0) + 1,
    generationClaimId: args.claimId,
    claimsUsados: [
      ...(previo?.claimsUsados ?? []),
      ...(previo?.generationClaimId ? [previo.generationClaimId] : []),
    ],
    cierreAdministrativo: false,
    chunksFueraDeCiclo: 0,
    sharingDecision: null,
    decidedByUid: null,
    decidedAt: null,
    onboardedAt: Timestamp.fromMillis(args.onboardedAtMs),
    deadlineAt: Timestamp.fromMillis(args.onboardedAtMs + HISTORY_SYNC_WINDOW_MS),
    requestedAt: null,
    syncTypesRequested: [],
    chunksObservados: [],
    observadosTruncado: false,
    chunksObservadosCount: 0,
    chunksDuplicados: 0,
    chunksFallidosPendientes: [],
    chunksSinTenant: 0,
    fallosSinClave: 0,
    mediaObservados: 0,
    maxProgress: null,
    lastChunkAt: null,
    declineCode: null,
    errorMessage: '',
    createdAt: now,
    updatedAt: now,
  });

  return db().runTransaction(async (tx) => {
    const previo = (await tx.get(ref)).data() as HistorySyncDoc | undefined;

    if (!previo) {
      tx.set(ref, generacionNueva(undefined));
      return { ok: true as const, syncGeneration: 1, reused: false };
    }
    if (previo.generationClaimId === args.claimId) {
      return { ok: true as const, syncGeneration: previo.syncGeneration, reused: true };
    }
    if ((previo.claimsUsados ?? []).includes(args.claimId)) {
      return {
        ok: false as const,
        reason: 'claim_superado' as const,
        explicacion: 'Ese onboarding pertenece a una generación ya cerrada: un callback viejo no puede reabrir ni resetear la sincronización vigente.',
      };
    }

    const cerrada: HistorySyncDoc = esEstadoTerminal(previo.status)
      ? previo
      : {
          ...previo,
          status: 'failed',
          cierreAdministrativo: true,
          errorMessage: 'superada por un nuevo onboarding autorizado (el número fue re-onboardeado sin que llegara el aviso de offboarding)',
          updatedAt: now,
        };
    // El archivo conserva la generación entera, con su desenlace: es auditoría, no papelera.
    tx.set(db().doc(archivoDeGeneracionPath(args.tenantId, args.phoneNumberId, cerrada.syncGeneration)), cerrada);
    const nueva = generacionNueva(previo);
    tx.set(ref, nueva);
    return { ok: true as const, syncGeneration: nueva.syncGeneration, reused: false };
  });
}
