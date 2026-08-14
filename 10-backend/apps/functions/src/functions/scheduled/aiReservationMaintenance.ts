/**
 * functions/scheduled/aiReservationMaintenance.ts — Recuperación de reservas de IA (ADR-0018)
 * ===========================================================================================
 * Red de seguridad del ciclo de reserva: una reserva `reservada` cuyo lease venció es un
 * resultado ambiguo (el proceso murió entre el proveedor y la liquidación) — se marca
 * `vencida` y su capacidad vuelve al tenant, sin doble cobro. El camino primario es la
 * recuperación LAZY dentro de la propia reserva; este barrido cubre tenants inactivos.
 * Complementa (no reemplaza) el patrón de attachmentRetentionMaintenance.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { runAiReservationSweep } from '../../entitlements/aiReservation.js';
import { runAiVisionSweep } from '../../ai/productVision.js';
import { ejecutarVisionJob } from '../../ai/productVisionRuntime.js';
import { ANTHROPIC_API_KEY } from '../../ai/aiSecret.js';
import { logger } from '../../lib/logger.js';

export const aiReservationMaintenance = onSchedule(
  { schedule: '10 * * * *', timeZone: 'America/Asuncion', region: 'us-central1', timeoutSeconds: 300, secrets: [ANTHROPIC_API_KEY] },
  async () => {
    const { vencidas } = await runAiReservationSweep();
    // ADR-0019: el mismo barrido horario recupera jobs de visión abandonados (lease vencido →
    // re-encolar y RE-DISPARAR: onDocumentCreated no ve updates; envío incierto → cerrar SIN
    // re-enviar). Un fallo no tapa al otro.
    const vision = await runAiVisionSweep({ procesar: ejecutarVisionJob }).catch(() => ({ reencolados: -1, inciertos: -1 }));
    logger.info('Mantenimiento de reservas de IA ejecutado', { vencidas, visionReencolados: vision.reencolados, visionInciertos: vision.inciertos });
  },
);
