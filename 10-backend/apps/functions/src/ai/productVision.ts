/**
 * ai/productVision.ts — Visión de productos contra el catálogo local (ADR-0019)
 * ==============================================================================
 * Job durable por adjunto elegible. La IA solo DESCRIBE (indicios universales validados por
 * schema); el catálogo del tenant es la única autoridad de nombre/precio/stock. El clasificador
 * determinístico de comprobantes (ADR-0016) tiene precedencia absoluta: un candidato/vinculado
 * jamás llega acá, y si la clasificación cambió entre el encolado y el worker, se cierra
 * fail-closed sin IA.
 *
 * Concurrencia: claim transaccional + lease (60 s) + FENCING por claimId — un worker zombi no
 * puede aplicar resultados ni enviar. Envío único: pendiente → en_vuelo (fenced) → enviado;
 * un `en_vuelo` con lease vencido se cierra `failed/envio_incierto` SIN re-enviar jamás.
 * El doc del job no lleva imagen, caption, prompt, respuesta cruda, rutas ni URLs.
 */
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { identificarProducto } from '../catalog/matchIdentificacion.js';
import type { ReservaDeIa } from '../entitlements/aiReservation.js';

/** Lease del job: con margen sobre el peor caso real del worker (descarga 10 MB + proveedor con
 *  timeout 20 s × 3 intentos del SDK). 60 s producía claims solapados de workers VIVOS (review). */
export const VISION_LEASE_MS = 5 * 60_000;
export const VISION_MAX_ATTEMPTS = 5;
/** PDF y documentos quedan FUERA (ADR-0019 §1): solo imágenes verificadas por magic bytes. */
export const VISION_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_OPCIONES = 3;

export const aiVisionJobPath = (tenantId: string, jobId: string): string =>
  `${paths.tenant(tenantId)}/aiVisionJobs/${jobId}`;

export type VisionJobStatus = 'queued' | 'processing' | 'succeeded' | 'skipped' | 'needs_clarification' | 'failed';

// ---------------------------------------------------------------------------
// Elegibilidad (pura, fail-closed): cualquier duda ⇒ no hay visión.
// ---------------------------------------------------------------------------

export interface VisionElegibilidadInput {
  flag: boolean;
  ingestState: string;
  clase: string;
  mimeVerificado: string | null | undefined;
  duplicate: boolean;
  yaPropuestoComoPago: boolean;
  classification: string | null | undefined;
  purgado: boolean;
}

export function decideVisionElegibilidad(i: VisionElegibilidadInput): { elegible: boolean; motivo?: string } {
  if (i.flag !== true) return { elegible: false, motivo: 'flag_apagado' };
  if (i.yaPropuestoComoPago) return { elegible: false, motivo: 'propuesto_como_pago' };
  if (i.classification !== 'generic_media' && i.classification !== 'unclassified') return { elegible: false, motivo: 'clasificacion_no_generica' };
  if (i.duplicate) return { elegible: false, motivo: 'duplicado' };
  if (i.ingestState !== 'stored') return { elegible: false, motivo: 'no_almacenado' };
  if (i.clase !== 'image') return { elegible: false, motivo: 'no_es_imagen' };
  if (!i.mimeVerificado || !(VISION_ALLOWED_MIME as readonly string[]).includes(i.mimeVerificado)) return { elegible: false, motivo: 'mime_no_permitido' };
  if (i.purgado) return { elegible: false, motivo: 'purgado' };
  return { elegible: true };
}

// ---------------------------------------------------------------------------
// Indicios universales (salida estructurada, validada y saneada; multi-vertical).
// ---------------------------------------------------------------------------

const cap = (n: number) => z.string().transform((s) => s.trim().slice(0, n)).pipe(z.string());
const indiciosSchema = z.object({
  textoVisible: cap(200).optional(),
  marcaAparente: cap(80).optional(),
  nombreAparente: cap(120).optional(),
  categoriaSugerida: cap(60).optional(),
  rasgos: z.array(z.string().transform((s) => s.trim().slice(0, 40))).max(8).optional(),
  confianza: z.enum(['alta', 'media', 'baja']),
});

export type VisionHints = z.infer<typeof indiciosSchema>;

/** Valida por schema (enum de confianza obligatorio), capa longitudes y DESCARTA todo campo extra:
 *  la IA no tiene ni dónde poner un precio, un id o una instrucción. Inválido ⇒ null (fail-closed). */
export function sanearIndicios(raw: unknown): VisionHints | null {
  if (!raw || typeof raw !== 'object') return null;
  const limpio: Record<string, unknown> = {};
  const permitidos = ['textoVisible', 'marcaAparente', 'nombreAparente', 'categoriaSugerida', 'rasgos', 'confianza'];
  for (const k of permitidos) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (k === 'rasgos') { if (Array.isArray(v)) limpio[k] = v.filter((x) => typeof x === 'string'); continue; }
    if (typeof v === 'string') limpio[k] = v;
  }
  const r = indiciosSchema.safeParse(limpio);
  return r.success ? r.data : null;
}

/** Términos de búsqueda planos. Los indicios son DATOS: jamás se interpretan ni ejecutan.
 *  Rasgos sueltos o confianza baja no alcanzan (⇒ null = evidencia insuficiente). */
export function construirConsulta(h: VisionHints): string | null {
  if (h.confianza === 'baja') return null;
  const terminos = [h.marcaAparente, h.nombreAparente, h.categoriaSugerida, h.textoVisible]
    .filter((t): t is string => typeof t === 'string' && t.trim().length >= 2)
    .map((t) => t.replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 2);
  if (!terminos.length) return null;
  return [...new Set(terminos)].join(' ').slice(0, 160);
}

export interface ProductoOfrecible { id: string; name: string; price: number }
export interface DesenlaceVision {
  tipo: 'unica' | 'multiple' | 'insuficiente' | 'sin_match';
  productos?: ProductoOfrecible[];
}

/** Los candidatos YA vienen curados por searchCatalog + guards; acá se exige IDENTIFICACIÓN
 *  real (matchIdentificacion, hito B+C): la identidad la da la evidencia de nombre contra la
 *  consulta — un candidato único DÉBIL ya no se afirma por estar solo (fail-closed ⇒ sin_match). */
export function decidirDesenlace(candidatos: ProductoOfrecible[], _h: VisionHints, consulta: string): DesenlaceVision {
  if (candidatos.length === 0) return { tipo: 'sin_match' };
  const id = identificarProducto(consulta, candidatos);
  if (id.tipo === 'matched') return { tipo: 'unica', productos: [id.producto] };
  if (id.tipo === 'ambiguous') return { tipo: 'multiple', productos: id.productos.slice(0, MAX_OPCIONES) };
  return { tipo: 'sin_match' };
}

const gs = (n: number): string => Math.round(n).toLocaleString('es-PY');

/** SIEMPRE con datos del servidor. El desenlace sin match jamás repite lo que "vio" el modelo. */
export function componerRespuestaVision(d: DesenlaceVision): string {
  if (d.tipo === 'unica' && d.productos?.[0]) {
    const p = d.productos[0];
    return `¡Creo que lo encontré! 📸 ${p.name} — ₲${gs(p.price)}. ¿Es este el que buscás?`;
  }
  if (d.tipo === 'multiple' && d.productos?.length) {
    const lista = d.productos.map((p) => `• ${p.name} — ₲${gs(p.price)}`).join('\n');
    return `Por la foto podría ser alguno de estos:\n${lista}\n¿Cuál es el que buscás?`;
  }
  if (d.tipo === 'insuficiente') {
    return 'Vi tu foto pero no logro distinguir bien el producto. ¿Me decís el nombre o la marca? También sirve una foto más de cerca.';
  }
  return 'Vi tu foto pero no encontré ese producto en nuestro catálogo. ¿Me decís el nombre o la marca para buscarlo mejor?';
}

// ---------------------------------------------------------------------------
// Encolado idempotente (el id del job ES el id del adjunto, ya determinístico).
// ---------------------------------------------------------------------------

export interface EncolarVisionParams {
  tenantId: string;
  customerId: string;
  attachmentId: string;
  messageId: string | null;
  sessionKey: string;
  channel: string;
  /** PNID por el que entró el mensaje: la respuesta sale por el MISMO número (ADR-0017). */
  receivedVia?: string | null;
  nowMs?: number;
}

export async function encolarVisionJob(p: EncolarVisionParams): Promise<{ encolado: boolean }> {
  const ref = db().doc(aiVisionJobPath(p.tenantId, p.attachmentId));
  try {
    await ref.create({
      id: p.attachmentId,
      tenantId: p.tenantId,
      customerId: p.customerId,
      attachmentId: p.attachmentId,
      messageId: p.messageId ?? null,
      sessionKey: p.sessionKey,
      channel: p.channel,
      receivedVia: p.receivedVia ?? null,
      status: 'queued' satisfies VisionJobStatus,
      attempts: 0,
      leaseUntil: null,
      claimId: null,
      envio: 'pendiente',
      createdAt: Timestamp.fromMillis(p.nowMs ?? Date.now()),
    });
    return { encolado: true };
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return { encolado: false };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// El worker.
// ---------------------------------------------------------------------------

export interface AdjuntoParaVision {
  attachmentId: string;
  tenantId: string;
  customerId: string;
  ingestState: string;
  class: string;
  mime?: { declared?: string | null; verified?: string | null } | null;
  bytes?: number | null;
  classification?: { value?: string | null } | null;
  storage?: { path?: string | null } | null;
  purgedAt?: unknown;
}

export interface VisionExtraction {
  status: 'ok' | 'error' | 'disabled';
  hints?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
  errorCode?: string;
}

export interface VisionJobDeps {
  flagActivo: (tenantId: string) => Promise<boolean>;
  leerAdjunto: (tenantId: string, attachmentId: string) => Promise<AdjuntoParaVision | null>;
  sesionEnTakeover: (tenantId: string, customerId: string, sessionKey: string) => Promise<boolean>;
  reservar: (tenantId: string, clave: string) => Promise<ReservaDeIa>;
  leerBytes: (adjunto: AdjuntoParaVision) => Promise<Buffer>;
  extraer: (input: { tenantId: string; mediaType: string; dataBase64: string }) => Promise<VisionExtraction>;
  buscar: (tenantId: string, consulta: string) => Promise<ProductoOfrecible[]>;
  enviar: (texto: string, ctx: { tenantId: string; customerId: string; sessionKey: string; channel: string }) => Promise<{ enviado: boolean; silenciado?: boolean }>;
  proyectarEnAdjunto: (tenantId: string, attachmentId: string, vision: { state: string; productName?: string }) => Promise<void>;
  now: () => number;
}

interface JobDoc {
  tenantId: string; customerId: string; attachmentId: string; sessionKey: string; channel: string;
  status: VisionJobStatus; attempts: number; leaseUntil: number | null; claimId: string | null;
  envio: 'pendiente' | 'en_vuelo' | 'enviado';
}

type ClaimResultado =
  | { r: 'tomado'; job: JobDoc; claimId: string }
  | { r: 'no_reclamado' } | { r: 'inexistente' } | { r: 'agotado' } | { r: 'envio_incierto' };

const TERMINALES: VisionJobStatus[] = ['succeeded', 'skipped', 'needs_clarification', 'failed'];

async function reclamar(tenantId: string, jobId: string, nowMs: number): Promise<ClaimResultado> {
  const ref = db().doc(aiVisionJobPath(tenantId, jobId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { r: 'inexistente' } as ClaimResultado;
    const job = snap.data() as JobDoc;
    if (TERMINALES.includes(job.status)) return { r: 'no_reclamado' } as ClaimResultado;
    if (job.status === 'processing') {
      const vigente = typeof job.leaseUntil === 'number' && job.leaseUntil > nowMs;
      if (vigente) return { r: 'no_reclamado' } as ClaimResultado;
      if (job.envio === 'en_vuelo') {
        // El worker anterior murió sin confirmar si el mensaje salió: JAMÁS re-enviar.
        tx.update(ref, { status: 'failed', motivo: 'envio_incierto', leaseUntil: null, updatedAt: Timestamp.fromMillis(nowMs) });
        return { r: 'envio_incierto' } as ClaimResultado;
      }
    }
    if ((job.attempts ?? 0) >= VISION_MAX_ATTEMPTS) {
      tx.update(ref, { status: 'failed', motivo: 'intentos_agotados', leaseUntil: null, updatedAt: Timestamp.fromMillis(nowMs) });
      return { r: 'agotado' } as ClaimResultado;
    }
    const claimId = randomUUID();
    tx.update(ref, { status: 'processing', claimId, leaseUntil: nowMs + VISION_LEASE_MS, attempts: (job.attempts ?? 0) + 1, updatedAt: Timestamp.fromMillis(nowMs) });
    return { r: 'tomado', job: { ...job, claimId }, claimId } as ClaimResultado;
  });
}

/** Toda escritura post-claim exige el claimId vigente (FENCING): un zombi no aplica nada. */
async function escribirConCerco(tenantId: string, jobId: string, claimId: string, data: Record<string, unknown>): Promise<boolean> {
  const ref = db().doc(aiVisionJobPath(tenantId, jobId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const job = snap.data() as JobDoc;
    if (job.claimId !== claimId) return false;
    tx.update(ref, data);
    return true;
  });
}

export type ProcesarResultado =
  | 'succeeded' | 'needs_clarification' | 'skipped' | 'reintentable' | 'agotado'
  | 'no_reclamado' | 'inexistente' | 'cercado' | 'envio_incierto';

export async function procesarVisionJob(tenantId: string, jobId: string, deps: VisionJobDeps): Promise<{ resultado: ProcesarResultado }> {
  const nowMs = deps.now();
  const claim = await reclamar(tenantId, jobId, nowMs);
  if (claim.r !== 'tomado') return { resultado: claim.r };
  const { job, claimId } = claim;
  const ts = () => Timestamp.fromMillis(deps.now());

  const cerrar = async (status: VisionJobStatus, motivo: string | null, extra: Record<string, unknown> = {}): Promise<boolean> =>
    escribirConCerco(tenantId, jobId, claimId, { status, motivo, leaseUntil: null, updatedAt: ts(), ...extra });

  // Gates fail-closed re-evaluados en el worker (el mundo pudo cambiar desde el encolado).
  if (!(await deps.flagActivo(tenantId))) { await cerrar('skipped', 'flag_apagado'); return { resultado: 'skipped' }; }
  const adjunto = await deps.leerAdjunto(tenantId, job.attachmentId);
  if (!adjunto) { await cerrar('skipped', 'adjunto_inexistente'); return { resultado: 'skipped' }; }
  const cls = adjunto.classification?.value ?? 'unclassified';
  const eleg = decideVisionElegibilidad({
    flag: true,
    ingestState: adjunto.ingestState,
    clase: adjunto.class,
    mimeVerificado: adjunto.mime?.verified ?? null,
    duplicate: false,
    yaPropuestoComoPago: cls === 'payment_receipt_candidate' || cls === 'payment_receipt_linked',
    classification: cls,
    purgado: Boolean(adjunto.purgedAt) || !adjunto.storage?.path,
  });
  if (!eleg.elegible) { await cerrar('skipped', eleg.motivo ?? 'no_elegible'); return { resultado: 'skipped' }; }
  if (await deps.sesionEnTakeover(tenantId, job.customerId, job.sessionKey)) {
    await cerrar('skipped', 'takeover');
    return { resultado: 'skipped' };
  }

  // Reserva de cuota (ADR-0018) ANTES del proveedor. Denegada ⇒ sin llamada, sin promesa rota.
  // La clave lleva el INTENTO (review ALTO 3): un error transitorio liquida/libera su reserva y
  // el reintento abre una nueva — el anti-duplicado concurrente lo dan claim+lease+fencing, no
  // la clave; el gasto sigue medido reserva a reserva.
  let reserva: ReservaDeIa;
  try {
    reserva = await deps.reservar(tenantId, `vision-${job.attachmentId}-a${job.attempts + 1}`);
  } catch {
    await cerrar('skipped', 'sin_cupo');
    return { resultado: 'skipped' };
  }
  if (reserva.cerrada) { await cerrar('skipped', 'reserva_cerrada'); return { resultado: 'skipped' }; }

  let bytes: Buffer;
  try {
    bytes = await deps.leerBytes(adjunto);
  } catch {
    await reserva.liberar('bytes_no_disponibles');
    await escribirConCerco(tenantId, jobId, claimId, { status: 'queued', claimId: null, leaseUntil: null, updatedAt: ts() });
    return { resultado: 'reintentable' };
  }

  const extraccion = await deps.extraer({ tenantId, mediaType: adjunto.mime?.verified ?? 'image/jpeg', dataBase64: bytes.toString('base64') });
  if (extraccion.status === 'disabled') {
    await reserva.liberar('proveedor_no_configurado');
    await cerrar('skipped', 'proveedor_no_configurado');
    return { resultado: 'skipped' };
  }
  // Liquidar el uso REAL (parcial en error incluido) — exactamente una vez (ADR-0018).
  await reserva.liquidar(extraccion.usage ?? { inputTokens: 0, outputTokens: 0 }, extraccion.costUsd ?? 0);
  if (extraccion.status === 'error') {
    const ok = await escribirConCerco(tenantId, jobId, claimId, { status: 'queued', claimId: null, leaseUntil: null, updatedAt: ts() });
    return { resultado: ok ? 'reintentable' : 'cercado' };
  }

  const indicios = sanearIndicios(extraccion.hints);
  const consulta = indicios ? construirConsulta(indicios) : null;
  let desenlace: DesenlaceVision;
  if (!indicios || !consulta) desenlace = { tipo: 'insuficiente' };
  else desenlace = decidirDesenlace(await deps.buscar(tenantId, consulta), indicios, consulta);

  // Envío ÚNICO: pendiente → en_vuelo (fenced) → enviar → terminal enviado (fenced).
  const enVuelo = await escribirConCerco(tenantId, jobId, claimId, { envio: 'en_vuelo', updatedAt: ts() });
  if (!enVuelo) return { resultado: 'cercado' };
  let envio: { enviado: boolean; silenciado?: boolean } = { enviado: false };
  try {
    envio = await deps.enviar(componerRespuestaVision(desenlace), { tenantId, customerId: job.customerId, sessionKey: job.sessionKey, channel: job.channel });
  } catch {
    envio = { enviado: false };
  }
  if (envio.silenciado) {
    // Guard autoritativo pre-envío (review ALTO 1): takeover o bot apagado en el último
    // instante ⇒ silencio absoluto, desenlace limpio (no es un envío incierto: NO se envió).
    await cerrar('skipped', 'silenciado', { envio: 'pendiente' });
    return { resultado: 'skipped' };
  }
  if (!envio.enviado) {
    await cerrar('failed', 'envio_incierto', { envio: 'en_vuelo' });
    return { resultado: 'envio_incierto' };
  }

  const status: VisionJobStatus = desenlace.tipo === 'multiple' || desenlace.tipo === 'insuficiente' ? 'needs_clarification' : 'succeeded';
  const resultado = {
    matchType: desenlace.tipo,
    productIds: (desenlace.productos ?? []).map((p) => p.id),
    ...(desenlace.tipo === 'unica' && desenlace.productos?.[0] ? { productName: desenlace.productos[0].name } : {}),
  };
  await cerrar(status, null, { envio: 'enviado', resultado });
  const estadoPanel = desenlace.tipo === 'unica' ? 'identificado' : desenlace.tipo === 'sin_match' ? 'sin_match' : 'aclaracion';
  try {
    await deps.proyectarEnAdjunto(tenantId, job.attachmentId, { state: estadoPanel, ...(resultado.productName ? { productName: resultado.productName } : {}) });
  } catch {
    logger.warn('productVision: proyección al adjunto falló (no bloquea)', { tenantId });
  }
  return { resultado: status === 'succeeded' ? 'succeeded' : 'needs_clarification' };
}

// ---------------------------------------------------------------------------
// Recuperación de jobs abandonados (barrido desde aiReservationMaintenance).
// ---------------------------------------------------------------------------

export async function runAiVisionSweep(opts: {
  nowMs?: number;
  max?: number;
  jobs?: Array<{ tenantId: string; jobId: string }>;
  /** Re-DISPARO tras re-encolar (review MEDIO 4): onDocumentCreated no ve un update a `queued`,
   *  así que sin esto un job re-encolado moría para siempre (lección de coverageMaintenance 3d). */
  procesar?: (tenantId: string, jobId: string, receivedVia: string | null) => Promise<unknown>;
} = {}): Promise<{ reencolados: number; inciertos: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  let candidatos = opts.jobs;
  if (!candidatos) {
    const q = await db()
      .collectionGroup('aiVisionJobs')
      .where('status', '==', 'processing')
      .where('leaseUntil', '<', nowMs)
      .limit(opts.max ?? 100)
      .get();
    candidatos = q.docs.map((d) => {
      const data = d.data() as { tenantId?: string; id?: string };
      return { tenantId: String(data.tenantId ?? ''), jobId: String(data.id ?? '') };
    }).filter((c) => c.tenantId && c.jobId);
  }
  let reencolados = 0, inciertos = 0;
  for (const c of candidatos) {
    try {
      const ref = db().doc(aiVisionJobPath(c.tenantId, c.jobId));
      const hecho = await db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const job = snap.data() as JobDoc & { receivedVia?: string | null };
        if (job.status !== 'processing' || !(typeof job.leaseUntil === 'number' && job.leaseUntil <= nowMs)) return null;
        if (job.envio === 'en_vuelo') {
          tx.update(ref, { status: 'failed', motivo: 'envio_incierto', leaseUntil: null, updatedAt: Timestamp.fromMillis(nowMs) });
          return { r: 'incierto' as const };
        }
        tx.update(ref, { status: 'queued', claimId: null, leaseUntil: null, updatedAt: Timestamp.fromMillis(nowMs) });
        return { r: 'reencolado' as const, receivedVia: job.receivedVia ?? null };
      });
      if (hecho?.r === 'reencolado') {
        reencolados++;
        if (opts.procesar) {
          try { await opts.procesar(c.tenantId, c.jobId, hecho.receivedVia ?? null); } catch { /* el próximo barrido insiste */ }
        }
      }
      if (hecho?.r === 'incierto') inciertos++;
    } catch {
      // un job conflictivo no frena el barrido de los demás
    }
  }
  if (reencolados || inciertos) logger.info('productVision: barrido de jobs', { reencolados, inciertos });
  return { reencolados, inciertos };
}
