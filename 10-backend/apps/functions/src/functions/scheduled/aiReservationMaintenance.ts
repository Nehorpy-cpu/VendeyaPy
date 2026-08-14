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
import { logger } from '../../lib/logger.js';

export const aiReservationMaintenance = onSchedule(
  { schedule: '10 * * * *', timeZone: 'America/Asuncion', region: 'us-central1', timeoutSeconds: 300 },
  async () => {
    const { vencidas } = await runAiReservationSweep();
    logger.info('Mantenimiento de reservas de IA ejecutado', { vencidas });
  },
);
