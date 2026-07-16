/**
 * COVERAGE-1D — Trigger del outbox de reanudación.
 * Reacciona a la CREACIÓN de un job `pending` (decisión de 1C) y a su REACTIVACIÓN
 * (held_by_seller→pending tras la liberación manual; send_failed→pending por mantenimiento).
 * El claim transaccional de processCoverageResumeJob garantiza UN solo procesador efectivo
 * aunque el trigger se dispare varias veces (retries de Eventarc incluidos).
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { processCoverageResumeJob } from '../../conversation/coverageResume.js';

export const onCoverageResumeJob = onDocumentWritten(
  { document: 'tenants/{tenantId}/coverageResumeJobs/{jobId}', region: 'us-central1' },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || after.status !== 'pending') return;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    if (before && before.status === 'pending') return; // sin transición real → el claim ya corre
    await processCoverageResumeJob(event.params.tenantId, event.params.jobId);
  },
);
