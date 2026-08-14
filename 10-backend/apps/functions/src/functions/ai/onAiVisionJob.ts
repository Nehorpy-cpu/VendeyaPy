/**
 * functions/ai/onAiVisionJob.ts — Disparador del job de visión (ADR-0019)
 * =======================================================================
 * Mismo patrón que onCoverageResumeJob: onDocumentCreated con retry — si el worker muere, la
 * reentrega de Eventarc lo retoma, y el claim transaccional + lease + fencing del núcleo hacen
 * que dos entregas jamás procesen (ni respondan) dos veces. El secreto de la API de IA viaja
 * bindeado igual que en el camino del sales agent.
 */
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { ejecutarVisionJob } from '../../ai/productVisionRuntime.js';
import { ANTHROPIC_API_KEY } from '../../ai/aiSecret.js';
import { logger } from '../../lib/logger.js';

export const onAiVisionJob = onDocumentCreated(
  {
    document: 'tenants/{tenantId}/aiVisionJobs/{jobId}',
    region: 'us-central1',
    retry: true,
    secrets: [ANTHROPIC_API_KEY],
    // Con margen sobre el lease de 5 min: el default de 60 s mataba al worker por timeout
    // justo en el peor caso del proveedor (review MEDIO 6).
    timeoutSeconds: 360,
  },
  async (event) => {
    const { tenantId, jobId } = event.params;
    const receivedVia = (event.data?.data() as { receivedVia?: string | null } | undefined)?.receivedVia ?? null;
    const r = await ejecutarVisionJob(tenantId, jobId, receivedVia);
    // `reintentable` relanza por Eventarc (throw); todo lo demás es desenlace legítimo.
    if (r.resultado === 'reintentable') throw new Error('vision job reintentable');
    logger.info('Visión: job procesado', { tenantId, resultado: r.resultado });
  },
);
