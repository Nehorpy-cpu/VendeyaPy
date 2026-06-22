/**
 * functions/ai/internalAssistantCallable.ts — Asistente interno de crecimiento (callable · AG-4)
 * =============================================================================================
 * `askInternalGrowthAssistant`: el OWNER (su empresa) o el PLATFORM_ADMIN (la empresa que indique en
 * `tenantId`) hace una pregunta interna y recibe una respuesta/recomendación de Claude Haiku con datos
 * AGREGADOS PRIVADOS del propio tenant (ganancia/margen). SELLER/VIEWER/MANAGER → 403. El tenant lo
 * resuelve el BACKEND (resolveOwnerAdminAuth): un owner SIEMPRE opera su propia empresa (se ignora
 * cualquier tenantId pedido → cross-tenant bloqueado). Read-only: el asistente no escribe nada de
 * negocio (las tools del contexto `internal` son solo lectura). Si el gateway está disabled / falla /
 * sin cupo → respuesta { ok:false } CONTROLADA y amigable (no rompe el callable). Auditoría: solo
 * metadatos en aiRequests (sin prompt ni PII), vía el gateway.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { resolveOwnerAdminAuth, type OwnerAdminToken } from '../../lib/ownerAdminAuth.js';
import { runInternalAssistant } from '../../ai/internalAssistant.js';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';

const MAX_MESSAGE_LEN = 2000;

export const askInternalGrowthAssistant = onCall<{ tenantId?: string; message?: unknown }>(
  { region: 'us-central1' },
  async (req) => {
    // 1. Auth: OWNER (su empresa) o PLATFORM_ADMIN (tenant indicado). SELLER/VIEWER/MANAGER → 403.
    if (!req.auth) throw new HttpsError('unauthenticated', 'Iniciá sesión para continuar.');
    const r = resolveOwnerAdminAuth(req.auth.token as OwnerAdminToken, req.data?.tenantId, {
      deniedMessage: 'Solo el dueño de la empresa o un administrador pueden usar el asistente interno.',
    });
    if (!r.ok) throw new HttpsError(r.code, r.message);
    const tenantId = r.tenantId; // un owner SIEMPRE su propio tenant; el tenantId del input se ignoró si no es admin
    const uid = req.auth.uid;

    // 2. Validar el mensaje (longitud).
    const message = typeof req.data?.message === 'string' ? req.data.message.trim() : '';
    if (!message) throw new HttpsError('invalid-argument', 'Escribí una pregunta para el asistente.');
    if (message.length > MAX_MESSAGE_LEN) {
      throw new HttpsError('invalid-argument', `La pregunta es muy larga (máximo ${MAX_MESSAGE_LEN} caracteres).`);
    }

    // 3. businessName para el prompt (best-effort; sin datos sensibles). Un fallo de Firestore NO debe
    // romper el callable: degradamos a '' (el prompt funciona sin el nombre del negocio).
    let businessName = '';
    try {
      businessName = ((await db().doc(`tenants/${tenantId}`).get()).data()?.name as string | undefined) ?? '';
    } catch {
      /* best-effort: seguimos sin el nombre */
    }

    // 4. Correr el asistente interno (gate + runAgent + metering). Error controlado, nunca rompe.
    const out = await runInternalAssistant({ tenantId, businessName, message, actorUid: uid });
    logger.info('askInternalGrowthAssistant', { tenantId, ok: out.ok, reason: out.ok ? undefined : out.reason });
    if (!out.ok) return { ok: false as const, reason: out.reason, message: out.message };
    return { ok: true as const, reply: out.reply };
  },
);
