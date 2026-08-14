/**
 * entitlements/aiReservation.ts — Reserva transaccional de cuota de IA (ADR-0018)
 * ===============================================================================
 * La ÚNICA abstracción por la que pasa toda llamada facturable al modelo (agente de ventas,
 * asistente interno, simulador y la futura visión). Reemplaza el check-then-act del gate
 * anterior (checkQuota suelto + increment ciego) por un ciclo persistido:
 *
 *   reservada ──liquidar──▶ liquidada      (uso real contabilizado UNA vez; la diferencia
 *       │                                   estimado-vs-real queda liberada)
 *       ├──────liberar────▶ liberada       (error ANTES de contactar al proveedor)
 *       └──lease vencido──▶ vencida        (resultado ambiguo: recuperable, sin doble cobro)
 *
 * Invariante bajo concurrencia: aiTokensThisMonth + aiTokensReserved ≤ límite del plan para
 * toda reserva admitida — las transacciones de Firestore serializan a los competidores.
 * La CLAVE del documento es el identificador lógico determinístico de la llamada (p. ej.
 * `ventas-{wamid}`): dos ejecuciones con la misma clave comparten UNA reserva.
 *
 * El doc de reserva persiste SOLO metadata operativa — jamás prompts, mensajes, imágenes,
 * PII ni credenciales. Las alertas van por la campana existente con el patrón canónico de
 * idempotencia (id determinístico + create() + tragar already-exists, como handoff.ts).
 */
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { db, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from '../audit/audit.js';
import { decideQuota } from './decide.js';
import { assertFeatureEnabled, resolveEntitlements } from './entitlements.js';
import { maybeResetUsage } from './usageReset.js';

/** Lease de una reserva: supera con margen la duración máxima real de un turno (timeout 10 s × 5 llamadas del loop). */
export const AI_RESERVATION_LEASE_MS = 10 * 60_000;

/** Umbrales de alerta (% del límite efectivo) — HANDOFF `AI-QUOTA-ALERTS-1`: 70/85/95/100. */
export const UMBRALES_ALERTA_IA = [70, 85, 95, 100] as const;

/** Estimaciones por tipo de operación, centralizadas (antes: EST_TOKENS_PER_TURN duplicado). */
const ESTIMACIONES = {
  texto_ventas: 1500,
  texto_interno: 1500,
  /** Declarada para el programa de visión/OCR — SIN consumidor todavía (ADR-0018 §6). */
  imagen_vision: 2600,
} as const;
export type EstimacionDeIa = keyof typeof ESTIMACIONES;
export function estimacionDeTokens(op: EstimacionDeIa): number {
  return ESTIMACIONES[op];
}

export const aiReservationPath = (tenantId: string, clave: string): string =>
  `${paths.tenant(tenantId)}/aiReservations/${clave}`;
const aiReservationsColl = (tenantId: string): string => `${paths.tenant(tenantId)}/aiReservations`;

export type AiReservationStatus = 'reservada' | 'liquidada' | 'liberada' | 'vencida';

export interface ReservaDeIa {
  clave: string;
  /** true = la clave ya estaba cerrada (liquidada/liberada/vencida): handle inerte, NO volver a llamar al proveedor. */
  cerrada: boolean;
  liquidar(usage: { inputTokens: number; outputTokens: number }, costUsd: number): Promise<{ aplicada: boolean }>;
  liberar(motivo?: string): Promise<{ aplicada: boolean }>;
}

interface UsageLeido {
  settled: number;
  reserved: number;
  costUsd: number;
  periodStartMs: number;
}

const leerUsage = (data: Record<string, unknown> | undefined): UsageLeido => {
  const u = (data?.['usage'] ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const ps = u['currentPeriodStart'] as { toMillis?: () => number } | undefined;
  return {
    settled: Math.max(0, n(u['aiTokensThisMonth'])),
    reserved: Math.max(0, n(u['aiTokensReserved'])),
    costUsd: Math.max(0, n(u['aiCostUsdThisMonth'])),
    periodStartMs: typeof ps?.toMillis === 'function' ? ps.toMillis() : 0,
  };
};

const sanearClave = (clave: string): string => clave.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 180) || 'sin-clave';

// ---------------------------------------------------------------------------
// Alertas por umbral — campana existente, idempotente por tenant × período × umbral.
// ---------------------------------------------------------------------------

const TIPO_POR_UMBRAL: Record<number, { type: string; title: string; body: (settled: number, limit: number) => string }> = {
  70: { type: 'ai_quota_70', title: 'Asistente IA: 70% del cupo usado', body: (s, l) => `El asistente ya usó ${s.toLocaleString('es-PY')} de ${l.toLocaleString('es-PY')} tokens del plan este período.` },
  85: { type: 'ai_quota_85', title: 'Asistente IA: 85% del cupo usado', body: (s, l) => `Quedan menos del 15% de los tokens del plan (${s.toLocaleString('es-PY')} de ${l.toLocaleString('es-PY')}). Considerá ampliar el plan.` },
  95: { type: 'ai_quota_95', title: 'Asistente IA: cupo casi agotado', body: (s, l) => `Va ${s.toLocaleString('es-PY')} de ${l.toLocaleString('es-PY')} tokens: al agotarse, las consultas derivan a tu equipo.` },
  100: { type: 'ai_quota_agotada', title: 'Asistente IA: cupo agotado', body: (_s, l) => `Se alcanzó el límite de ${l.toLocaleString('es-PY')} tokens del plan. Las consultas que necesitan IA ahora derivan a tu equipo. Ampliá el plan para reactivarlo.` },
};

const periodoClave = (periodStartMs: number): string => {
  const d = new Date(periodStartMs > 0 ? periodStartMs : 0);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Emite la campana del umbral si no existe todavía (create + tragar already-exists). Best-effort. */
async function emitirAlerta(tenantId: string, umbral: number, settled: number, limit: number, periodStartMs: number): Promise<void> {
  const copy = TIPO_POR_UMBRAL[umbral];
  if (!copy) return;
  const id = `ai-quota-${periodoClave(periodStartMs)}-${umbral}`;
  try {
    await db().doc(`${paths.notifications(tenantId)}/${id}`).create({
      id,
      tenantId,
      category: 'ai_quota',
      type: copy.type,
      title: copy.title,
      body: copy.body(settled, limit),
      dedupeKey: id,
      read: false,
      readAt: null,
      createdAt: Timestamp.now(),
    });
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists') return; // idempotencia: ya avisado este período
    logger.warn('aiReservation: no se pudo emitir la alerta de cuota', { tenantId, umbral });
  }
}

/**
 * Evalúa umbrales tras una liquidación. Ilimitado jamás alerta. Se emite para TODO umbral ya
 * alcanzado (no solo el recién cruzado): si el proceso murió entre una liquidación y su alerta,
 * la siguiente lo repara — el `create()` idempotente deduplica (review final, BAJO 2).
 */
async function evaluarUmbrales(tenantId: string, newSettled: number, limit: number, unlimited: boolean, periodStartMs: number): Promise<void> {
  if (unlimited || limit <= 0) return;
  const newPct = (newSettled * 100) / limit;
  for (const u of UMBRALES_ALERTA_IA) {
    if (newPct >= u) await emitirAlerta(tenantId, u, newSettled, limit, periodStartMs);
  }
}

// ---------------------------------------------------------------------------
// Vencimiento y recuperación (lease + patrón de mantenimiento existente).
// ---------------------------------------------------------------------------

/** Vence UNA reserva (tx propia): reservada → vencida + devolución del contador con clamp. */
async function vencerReserva(tenantId: string, clave: string, nowMs: number): Promise<boolean> {
  const resRef = db().doc(aiReservationPath(tenantId, clave));
  const tenantRef = db().doc(paths.tenant(tenantId));
  return db().runTransaction(async (tx) => {
    const [resSnap, tenSnap] = [await tx.get(resRef), await tx.get(tenantRef)];
    const res = resSnap.data() as { status?: string; estimatedTokens?: number } | undefined;
    if (!res || res.status !== 'reservada') return false;
    const { reserved } = leerUsage(tenSnap.data() as Record<string, unknown> | undefined);
    const est = Math.max(0, res.estimatedTokens ?? 0);
    tx.update(resRef, { status: 'vencida', expiredAt: Timestamp.fromMillis(nowMs) });
    tx.set(tenantRef, { usage: { aiTokensReserved: Math.max(0, reserved - est) } }, { merge: true });
    return true;
  });
}

/** Barre las reservas vencidas de UN tenant (query acotada). Devuelve cuántas venció. */
export async function recuperarReservasVencidas(tenantId: string, nowMs: number, max = 20): Promise<number> {
  const q = await db()
    .collection(aiReservationsColl(tenantId))
    .where('status', '==', 'reservada')
    .where('expiresAt', '<', nowMs)
    .limit(max)
    .get();
  let vencidas = 0;
  for (const d of q.docs) {
    const clave = String((d.data() as { id?: string }).id ?? d.ref.path.split('/').pop());
    if (await vencerReserva(tenantId, clave, nowMs)) vencidas++;
  }
  return vencidas;
}

/** Barrido global (scheduler `aiReservationMaintenance`): collection-group sobre todas las empresas. */
export async function runAiReservationSweep(opts: { nowMs?: number; max?: number } = {}): Promise<{ vencidas: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const q = await db()
    .collectionGroup('aiReservations')
    .where('status', '==', 'reservada')
    .where('expiresAt', '<', nowMs)
    .limit(opts.max ?? 200)
    .get();
  let vencidas = 0;
  for (const d of q.docs) {
    const data = d.data() as { tenantId?: string; id?: string };
    if (!data.tenantId || !data.id) continue;
    if (await vencerReserva(data.tenantId, data.id, nowMs)) vencidas++;
  }
  if (vencidas > 0) logger.info('aiReservation: reservas vencidas recuperadas', { vencidas });
  return { vencidas };
}

// ---------------------------------------------------------------------------
// La reserva.
// ---------------------------------------------------------------------------

interface IntentoDeReserva {
  resultado: 'creada' | 'reusada' | 'cerrada' | 'sin_capacidad';
  settled: number;
  reserved: number;
  limit: number;
  unlimited: boolean;
  periodStartMs: number;
}

async function intentarReserva(tenantId: string, clave: string, est: number, context: string, limit: number, nowMs: number): Promise<IntentoDeReserva> {
  const tenantRef = db().doc(paths.tenant(tenantId));
  const resRef = db().doc(aiReservationPath(tenantId, clave));
  return db().runTransaction(async (tx) => {
    const [tenSnap, resSnap] = [await tx.get(tenantRef), await tx.get(resRef)];
    const usage = leerUsage(tenSnap.data() as Record<string, unknown> | undefined);
    const previa = resSnap.data() as { status?: string } | undefined;
    if (previa) {
      const resultado = previa.status === 'reservada' ? 'reusada' : 'cerrada';
      return { resultado, ...usage, limit, unlimited: decideQuota(0, limit, 0).unlimited } as IntentoDeReserva;
    }
    const d = decideQuota(usage.settled + usage.reserved, limit, est);
    if (!d.allowed) return { resultado: 'sin_capacidad', ...usage, limit, unlimited: d.unlimited } as IntentoDeReserva;
    tx.create(resRef, {
      id: clave,
      tenantId,
      context,
      status: 'reservada' satisfies AiReservationStatus,
      estimatedTokens: est,
      periodStartMs: usage.periodStartMs,
      reservedAt: Timestamp.fromMillis(nowMs),
      expiresAt: nowMs + AI_RESERVATION_LEASE_MS,
    });
    tx.set(tenantRef, { usage: { aiTokensReserved: usage.reserved + est } }, { merge: true });
    return { resultado: 'creada', ...usage, reserved: usage.reserved + est, limit, unlimited: d.unlimited } as IntentoDeReserva;
  });
}

function construirHandle(tenantId: string, clave: string, est: number, cerrada: boolean): ReservaDeIa {
  const tenantRef = db().doc(paths.tenant(tenantId));
  const resRef = db().doc(aiReservationPath(tenantId, clave));

  const liquidar = async (usage: { inputTokens: number; outputTokens: number }, costUsd: number): Promise<{ aplicada: boolean }> => {
    if (cerrada) return { aplicada: false };
    const real = Math.max(0, Math.ceil((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)));
    const costo = Math.max(0, costUsd ?? 0);
    try {
      const r = await db().runTransaction(async (tx) => {
        const [resSnap, tenSnap] = [await tx.get(resRef), await tx.get(tenantRef)];
        const res = resSnap.data() as { status?: string; estimatedTokens?: number } | undefined;
        if (!res || res.status !== 'reservada') return null;
        const u = leerUsage(tenSnap.data() as Record<string, unknown> | undefined);
        // El decremento usa el estimado DEL DOC (lo que la reserva incrementó al crearse), no el
        // del closure: en un handle `reusada` pueden diferir y el espejo driftaría para siempre
        // (review final, MEDIO 1 — misma regla que vencerReserva).
        const estDoc = Math.max(0, res.estimatedTokens ?? est);
        if (u.reserved - estDoc < 0) logger.warn('aiReservation: clamp en liquidación (espejo desalineado)', { tenantId, clave, reserved: u.reserved, estDoc });
        tx.update(resRef, { status: 'liquidada', actualTokens: real, costUsd: costo, settledAt: Timestamp.now() });
        tx.set(tenantRef, {
          usage: {
            aiTokensThisMonth: u.settled + real,
            aiCostUsdThisMonth: u.costUsd + costo,
            aiTokensReserved: Math.max(0, u.reserved - estDoc),
          },
        }, { merge: true });
        return { prevSettled: u.settled, newSettled: u.settled + real, periodStartMs: u.periodStartMs };
      });
      if (!r) return { aplicada: false };
      // Alertas por umbral (fuera de la tx; idempotentes por id). El límite se resuelve fresco.
      try {
        const ent = await resolveEntitlements(tenantId);
        const limit = ent.limits.maxAiTokensPerMonth;
        await evaluarUmbrales(tenantId, r.newSettled, limit, decideQuota(0, limit, 0).unlimited, r.periodStartMs);
      } catch {
        logger.warn('aiReservation: alertas no evaluadas', { tenantId });
      }
      return { aplicada: true };
    } catch (e) {
      // La liquidación jamás rompe la respuesta al cliente: la reserva queda `reservada`
      // y la recupera el vencimiento (sin doble cobro). Se registra para diagnóstico.
      logger.warn('aiReservation: liquidación fallida (queda recuperable)', { tenantId, clave, code: (e as { code?: unknown }).code });
      return { aplicada: false };
    }
  };

  const liberar = async (motivo?: string): Promise<{ aplicada: boolean }> => {
    if (cerrada) return { aplicada: false };
    try {
      const aplicada = await db().runTransaction(async (tx) => {
        const [resSnap, tenSnap] = [await tx.get(resRef), await tx.get(tenantRef)];
        const res = resSnap.data() as { status?: string; estimatedTokens?: number } | undefined;
        if (!res || res.status !== 'reservada') return false;
        const u = leerUsage(tenSnap.data() as Record<string, unknown> | undefined);
        // Ídem liquidar: el estimado DEL DOC, jamás el del closure (review final, MEDIO 1).
        const estDoc = Math.max(0, res.estimatedTokens ?? est);
        if (u.reserved - estDoc < 0) logger.warn('aiReservation: clamp en liberación (espejo desalineado)', { tenantId, clave, reserved: u.reserved, estDoc });
        tx.update(resRef, { status: 'liberada', releasedAt: Timestamp.now(), motivo: motivo ?? null });
        tx.set(tenantRef, { usage: { aiTokensReserved: Math.max(0, u.reserved - estDoc) } }, { merge: true });
        return true;
      });
      return { aplicada };
    } catch (e) {
      logger.warn('aiReservation: liberación fallida (queda recuperable)', { tenantId, clave, code: (e as { code?: unknown }).code });
      return { aplicada: false };
    }
  };

  return { clave, cerrada, liquidar, liberar };
}

/**
 * Reserva capacidad de IA ANTES de contactar al proveedor. Contrato de errores idéntico al
 * gate anterior (los mapeos estructurados de los agentes no cambian):
 *  - feature off / suspensión / trial vencido → HttpsError 'failed-precondition'
 *  - sin capacidad                            → HttpsError 'resource-exhausted'
 */
export async function reservarTurnoDeIa(
  tenantId: string,
  clave: string,
  estimatedTokens: number,
  opts: { context: string; actorUid?: string | null; nowMs?: number },
): Promise<ReservaDeIa> {
  const nowMs = opts.nowMs ?? Date.now();
  const est = Math.max(1, Math.ceil(estimatedTokens));
  const claveSana = sanearClave(clave);

  // Gates previos, sin cambios de contrato: feature del plan + posture/trial.
  await assertFeatureEnabled(tenantId, 'aiAssistant', { actorUid: opts.actorUid });
  await maybeResetUsage(tenantId);
  const ent = await resolveEntitlements(tenantId);
  if (!ent.posture.operational) {
    await recordAudit({ tenantId, action: 'entitlement.blocked', actorUid: opts.actorUid ?? null, targetType: 'entitlement', summary: 'Reserva de IA bloqueada: suspendida por billing', metadata: { metric: 'aiTokens', reason: 'suspended' } });
    throw new HttpsError('failed-precondition', 'La empresa está suspendida por billing.');
  }
  if (ent.trialExpired) {
    await recordAudit({ tenantId, action: 'entitlement.blocked', actorUid: opts.actorUid ?? null, targetType: 'entitlement', summary: 'Reserva de IA bloqueada: prueba vencida', metadata: { metric: 'aiTokens', reason: 'trial_expired' } });
    throw new HttpsError('failed-precondition', 'Tu prueba gratis de 7 días terminó. Activá un plan para seguir usando la plataforma.');
  }
  const limit = ent.limits.maxAiTokensPerMonth;

  let intento = await intentarReserva(tenantId, claveSana, est, opts.context, limit, nowMs);
  if (intento.resultado === 'sin_capacidad') {
    // Recuperación LAZY: reservas vencidas del propio tenant pueden estar reteniendo capacidad.
    const recuperadas = await recuperarReservasVencidas(tenantId, nowMs);
    if (recuperadas > 0) intento = await intentarReserva(tenantId, claveSana, est, opts.context, limit, nowMs);
  }

  if (intento.resultado === 'sin_capacidad') {
    await recordAudit({
      tenantId, action: 'entitlement.blocked', actorUid: opts.actorUid ?? null, targetType: 'entitlement',
      summary: `Bloqueado por quota_exceeded (aiTokens): ${intento.settled + intento.reserved}/${limit}`,
      metadata: { metric: 'aiTokens', reason: 'quota_exceeded', used: intento.settled, reserved: intento.reserved, limit, estimated: est },
    });
    await emitirAlerta(tenantId, 100, intento.settled, limit, intento.periodStartMs);
    throw new HttpsError('resource-exhausted', `Alcanzaste el límite de tu plan (aiTokens: ${limit}). Actualizá tu plan para continuar.`);
  }

  return construirHandle(tenantId, claveSana, est, intento.resultado === 'cerrada');
}
