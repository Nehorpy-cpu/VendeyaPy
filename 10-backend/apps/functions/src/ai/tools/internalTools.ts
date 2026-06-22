/**
 * ai/tools/internalTools.ts — Tools del internal_growth_assistant (AG-2)
 * =====================================================================
 * READ-ONLY y SOLO del propio tenant (tenantId del contexto, nunca de `input`). Acá SÍ se permiten
 * agregados sensibles (márgenes/ganancia) porque es el asistente interno del owner/admin. NO hace
 * writes ni acciones críticas. Inyectable (deps) para tests sin Firestore.
 */
import type { TenantStatsPublic, TenantStatsPrivate } from '@vpw/shared';
import { db } from '../../lib/firebase.js';
import type { AiTool, AiToolHandler } from '../types.js';
import { sanitizeInternalStats, type InternalSalesSummary } from './sanitize.js';

export interface InternalStatsDeps {
  readStats: (tenantId: string) => Promise<{ pub: TenantStatsPublic | null; priv: TenantStatsPrivate | null }>;
}
const defaultStatsDeps: InternalStatsDeps = {
  readStats: async (tenantId) => {
    const [pubSnap, privSnap] = await Promise.all([
      db().doc(`tenants/${tenantId}/stats/public`).get(),
      db().doc(`tenants/${tenantId}/stats/private`).get(),
    ]);
    return {
      pub: pubSnap.exists ? (pubSnap.data() as TenantStatsPublic) : null,
      priv: privSnap.exists ? (privSnap.data() as TenantStatsPrivate) : null,
    };
  },
};

const resumenVentasDef: AiTool = {
  name: 'resumen_ventas',
  description: 'Devuelve el resumen agregado de ventas del negocio (ventas, ingresos, ticket promedio, ganancia, margen y top productos). Solo lectura, solo de este negocio.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

export const resumenVentas: AiToolHandler = {
  definition: resumenVentasDef,
  async execute(tenantId: string, _input: Record<string, unknown>, deps: InternalStatsDeps = defaultStatsDeps): Promise<InternalSalesSummary> {
    // tenantId del contexto; cualquier tenantId en `input` se ignora. Solo lectura.
    const { pub, priv } = await deps.readStats(tenantId);
    return sanitizeInternalStats(pub, priv);
  },
};
