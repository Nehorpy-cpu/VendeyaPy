/**
 * verify-ai-vision.mjs — E2E de visión de productos (ADR-0019)
 * ============================================================
 * Contra emuladores limpios (firestore+storage), con el CÓDIGO COMPILADO real (lib/), una imagen
 * SINTÉTICA subida al Storage del emulador y el FakeAiClient del gateway (fixture en
 * aiTestFixtures/ai — jamás un proveedor real). Catálogo sintético de una vertical NO-perfumería
 * (macetas) para demostrar el contrato multi-vertical.
 *
 *   node scripts/verify-ai-vision.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
process.env.GCLOUD_PROJECT ??= 'demo-aiafg';
process.env.FUNCTIONS_EMULATOR = 'true'; // getAiClient() ⇒ FakeAiClient (fixture, cero red)
const envLocal = join(raiz, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const { initializeApp, getApps } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const { getStorage } = await import('firebase-admin/storage');
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT, storageBucket: `${process.env.GCLOUD_PROJECT}.appspot.com` });
const db = getFirestore();

const { aiVisionJobPath } = await import(new URL('../lib/ai/productVision.js', import.meta.url).href);
const { ejecutarVisionJob } = await import(new URL('../lib/ai/productVisionRuntime.js', import.meta.url).href);
const { hashProviderMessageId } = await import(new URL('../../../packages/shared/dist/attachmentIdentity.js', import.meta.url).href);

let ok = 0, fail = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};

const T = 'e2e_vision_a';
const T2 = 'e2e_vision_b';
const CUST = '0000900001';
const ATT = 'att_aaaaaaaaaaaaaaaaaaaaaaa1';
const ATT2 = 'att_aaaaaaaaaaaaaaaaaaaaaaa2';
const ATT3 = 'att_aaaaaaaaaaaaaaaaaaaaaaa3';
const now = Timestamp.now();
// JPEG sintético mínimo: magic bytes reales + relleno. Jamás una imagen real.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 7), Buffer.from([0xff, 0xd9])]);

async function sembrarTenant(t, flagOn) {
  await db.doc(`plans/e2e-vision`).set({
    id: 'e2e-vision', tier: 'STARTER', name: 'e2e', description: 'e2e', priceUsdPerMonth: 0, pricePygPerMonth: 0,
    limits: { maxProducts: 100, maxOrdersPerMonth: 100, maxWhatsappMessagesPerMonth: 1000, maxDeliveryPersons: 5, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 100_000 },
    features: { aiAssistant: true, marketingAutomation: false },
  });
  await db.doc(`tenants/${t}`).set({
    id: t, name: t, planId: 'e2e-vision', status: 'ACTIVE', isDemo: false,
    subscription: { status: 'none', planId: 'e2e-vision' },
    usage: { aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, aiTokensReserved: 0, ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, currentPeriodStart: now },
    createdAt: now, updatedAt: now,
  });
  await db.doc(`tenants/${t}/config/productVision`).set({ enabled: flagOn });
  await db.doc(`tenants/${t}/config/agent`).set({ agentName: 'Bot', businessName: t, greetingMessage: 'hola', botEnabled: true, profitMode: false, industry: 'plantas', updatedAt: now });
}

async function sembrarAdjunto(t, attId, storagePath, over = {}) {
  await db.doc(`tenants/${t}/attachments/${attId}`).set({
    attachmentId: attId, tenantId: t, customerId: CUST, conversationId: CUST, messageId: `pmid_${attId}`,
    providerMessageId: `pmid_${attId}`, channel: 'whatsapp', class: 'image', direction: 'in', author: 'customer',
    ingestState: 'stored', classification: { value: 'generic_media', source: 'rule', confidence: 1, by: null, at: now },
    caption: '', filename: null, mime: { declared: 'image/jpeg', verified: 'image/jpeg' }, bytes: JPEG.length,
    checksum: 'e2e', storage: { path: storagePath }, orderCandidateId: null, retentionUntil: null, purgedAt: null,
    createdAt: now, updatedAt: now, lastError: null, ...over,
  });
}

// ── Limpieza + siembra ──────────────────────────────────────────────────────
for (const t of [T, T2]) {
  for (const coll of ['aiVisionJobs', 'aiReservations', 'attachments', 'products']) {
    const snap = await db.collection(`tenants/${t}/${coll}`).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  const msgs = await db.collection(`tenants/${t}/customers/${CUST}/messages`).get();
  for (const d of msgs.docs) await d.ref.delete();
}
await sembrarTenant(T, true);
await sembrarTenant(T2, false);
// Catálogo sintético NO-perfumería: una coincidencia fuerte para "Maceta Barro".
await db.doc(`tenants/${T}/products/prod_maceta`).set({
  id: 'prod_maceta', tenantId: T, name: 'Maceta de Barro 20cm', description: 'Maceta artesanal', price: 85_000,
  currency: 'PYG', status: 'ACTIVE', inventory: { trackStock: true, stock: 5 }, styleTags: [], createdAt: now, updatedAt: now,
});
await db.doc(`tenants/${T}/products/prod_inactivo`).set({
  id: 'prod_inactivo', tenantId: T, name: 'Maceta de Barro Vieja', description: 'no vendible', price: 10_000,
  currency: 'PYG', status: 'INACTIVE', inventory: { trackStock: true, stock: 0 }, styleTags: [], createdAt: now, updatedAt: now,
});
const bucket = getStorage().bucket();
const PATH1 = `tenants/${T}/attachments/ab/${ATT}`;
await bucket.file(PATH1).save(JPEG, { contentType: 'image/jpeg' });
await sembrarAdjunto(T, ATT, PATH1);
// Fixture del FakeAiClient: la tool forzada devuelve indicios que apuntan a la maceta.
await db.doc('aiTestFixtures/ai').set({
  toolUses: [{ id: 't1', name: 'reportar_indicios', input: { marcaAparente: 'Barro', nombreAparente: 'Maceta', categoriaSugerida: 'macetas', confianza: 'alta' } }],
  inputTokens: 1300, outputTokens: 70,
});

const TERMINALES = ['succeeded', 'skipped', 'needs_clarification', 'failed'];
const esperarTerminal = async (t, jobId, timeoutMs = 20_000) => {
  const fin = Date.now() + timeoutMs;
  for (;;) {
    const j = (await db.doc(aiVisionJobPath(t, jobId)).get()).data();
    if (j && TERMINALES.includes(j.status)) return j;
    if (Date.now() > fin) return j ?? null;
    await new Promise((r) => setTimeout(r, 400));
  }
};
const outMsgs = async (t) => (await db.collection(`tenants/${t}/customers/${CUST}/messages`).get()).docs
  .map((d) => d.data()).filter((m) => m.direction === 'out');

console.log('— 1/5: el PRODUCTOR real (trigger onAiVisionProducer sobre la transición a processed) —');
// El adjunto sembrado debe llevar el messageId determinístico que el productor recomputa.
const WAMID = 'wamid_e2e_producer_1';
const PMID = hashProviderMessageId(T, WAMID);
await db.doc(`tenants/${T}/attachments/${ATT}`).update({ messageId: PMID });
// La sessionKey la deriva la MISMA autoridad compartida (derivarSessionKey): el ASSET manda.
// Se siembran asset + índice como en la realidad productiva del canal heredado.
await db.doc(`tenants/${T}/metaAssets/wa-e2e-1`).set({ id: 'wa-e2e-1', tenantId: T, assetType: 'whatsapp_phone_number', externalId: 'wa-e2e-1', connectionId: 'main', sessionKey: 'active', status: 'active', selected: true });
await db.doc(`metaExternalIndex/whatsapp_wa-e2e-1`).set({ id: 'whatsapp_wa-e2e-1', tenantId: T, connectionId: 'main', externalId: 'wa-e2e-1', platform: 'whatsapp', status: 'active' });
const EV = `whatsapp_${WAMID}`;
// Evento con el shape REAL del inbox: en 'processing', con tenantId sellado y mediaId ya anulado
// (= el archivo quedó almacenado), tal como lo deja el process.ts productivo al cerrar.
await db.doc(`metaWebhookInbox/${EV}`).set({
  id: EV, platform: 'whatsapp', kind: 'message', objectType: 'message', eventType: 'messages',
  externalId: 'wa-e2e-1', tenantId: T, processingStatus: 'processing', automationEligible: true,
  payload: { from: CUST, messageId: WAMID, attachment: { kind: 'image', mediaId: null, declaredMime: 'image/jpeg' } },
  receivedAt: now, processedAt: null, errorMessage: '',
});
// LA transición durable que el productor observa:
await db.doc(`metaWebhookInbox/${EV}`).update({ processingStatus: 'processed', processedAt: Timestamp.now() });
const esperarJob = async (t, jobId, timeoutMs = 20_000) => {
  const fin = Date.now() + timeoutMs;
  for (;;) {
    const j = (await db.doc(aiVisionJobPath(t, jobId)).get()).data();
    if (j) return j;
    if (Date.now() > fin) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
};
const jobCreado = await esperarJob(T, ATT);
check('1. la transición processing→processed produce EXACTAMENTE un job (tenant sellado, sessionKey del índice)',
  jobCreado !== null && jobCreado.tenantId === T && jobCreado.sessionKey === 'active' && jobCreado.receivedVia === 'wa-e2e-1',
  `job=${JSON.stringify({ t: jobCreado?.tenantId, sk: jobCreado?.sessionKey })}`);
// Redelivery/transición repetida: otro update sobre un doc YA processed ⇒ before=processed ⇒ no-op.
await db.doc(`metaWebhookInbox/${EV}`).update({ processedAt: Timestamp.now() });
await new Promise((r) => setTimeout(r, 2500));
const jobsT = (await db.collection(`tenants/${T}/aiVisionJobs`).get()).size;
check('1b. la transición repetida NO duplica (sigue habiendo un solo job)', jobsT === 1, `jobs=${jobsT}`);

console.log('— 2/5: ciclo completo con coincidencia fuerte —');
// El emulador de functions dispara onAiVisionJob REAL sobre el doc creado: se espera su desenlace.
const job1 = await esperarTerminal(T, ATT);
const outs1 = await outMsgs(T);
check('2. el TRIGGER real procesa el job: succeeded, envío único, nombre y precio DEL CATÁLOGO',
  job1?.status === 'succeeded' && job1?.envio === 'enviado' &&
  outs1.length === 1 && /Maceta de Barro 20cm/.test(outs1[0].text) && /85\.000/.test(outs1[0].text),
  `job=${job1?.status} outs=${outs1.length}`);
check('2b. el INACTIVO jamás se ofrece (guards del catálogo)', !/Vieja/.test(outs1[0]?.text ?? ''));
const resv = (await db.doc(`tenants/${T}/aiReservations/vision-${ATT}-a1`).get()).data();
check('2c. la reserva imagen_vision quedó LIQUIDADA con el uso real', resv?.status === 'liquidada' && resv?.actualTokens === 1370, `resv=${resv?.status}/${resv?.actualTokens}`);
const att1 = (await db.doc(`tenants/${T}/attachments/${ATT}`).get()).data();
check('2d. el chip del panel: vision.state=identificado con el nombre del producto', att1?.vision?.state === 'identificado' && att1?.vision?.productName === 'Maceta de Barro 20cm');
const textoJob = JSON.stringify(job1);
check('2e. el job no lleva imagen, prompts, rutas ni URLs', !/dataBase64|prompt|attachments\/|https?:/.test(textoJob));

console.log('— 3/5: re-proceso de un job terminal = no_reclamado, sin segundo mensaje —');
const r2 = await ejecutarVisionJob(T, ATT, 'wa-e2e-1');
check('3. reentrega del trigger sobre job terminal ⇒ no_reclamado y sigue habiendo UNA respuesta',
  r2.resultado === 'no_reclamado' && (await outMsgs(T)).length === 1);

console.log('— 4/5: fail-closed — flag apagado, comprobante y takeover —');
await sembrarAdjunto(T2, ATT, PATH1);
await db.doc(aiVisionJobPath(T2, ATT)).set({ id: ATT, tenantId: T2, customerId: CUST, attachmentId: ATT, messageId: 'x', sessionKey: 'wa_e2e', channel: 'whatsapp', receivedVia: null, status: 'queued', attempts: 0, leaseUntil: null, claimId: null, envio: 'pendiente', createdAt: now });
const jobOff = await esperarTerminal(T2, ATT);
const aiReqsT2 = (await db.collection(`tenants/${T2}/aiRequests`).get()).size;
check('4. flag apagado ⇒ skipped y CERO llamadas de IA para ese tenant', jobOff?.status === 'skipped' && aiReqsT2 === 0, `job=${jobOff?.status}`);
const PATH2 = `tenants/${T}/attachments/ab/${ATT2}`;
await bucket.file(PATH2).save(JPEG, { contentType: 'image/jpeg' });
await sembrarAdjunto(T, ATT2, PATH2, { classification: { value: 'payment_receipt_candidate', source: 'rule', confidence: 1, by: null, at: now }, messageId: hashProviderMessageId(T, 'wamid_e2e_rec') });
await db.doc(aiVisionJobPath(T, ATT2)).set({ id: ATT2, tenantId: T, customerId: CUST, attachmentId: ATT2, messageId: 'x', sessionKey: 'wa_e2e', channel: 'whatsapp', receivedVia: null, status: 'queued', attempts: 0, leaseUntil: null, claimId: null, envio: 'pendiente', createdAt: now });
const jobRec = await esperarTerminal(T, ATT2);
check('4b. comprobante candidato ⇒ skipped SIN visión (precedencia absoluta)', jobRec?.status === 'skipped' && (await outMsgs(T)).length === 1, );
const PATH3 = `tenants/${T}/attachments/ab/${ATT3}`;
await bucket.file(PATH3).save(JPEG, { contentType: 'image/jpeg' });
await sembrarAdjunto(T, ATT3, PATH3);
await db.doc(`tenants/${T}/customers/${CUST}/sessions/wa_e2e`).set({ id: 'wa_e2e', state: 'IDLE', context: { humanTakeover: true }, updatedAt: now });
await db.doc(aiVisionJobPath(T, ATT3)).set({ id: ATT3, tenantId: T, customerId: CUST, attachmentId: ATT3, messageId: 'x', sessionKey: 'wa_e2e', channel: 'whatsapp', receivedVia: null, status: 'queued', attempts: 0, leaseUntil: null, claimId: null, envio: 'pendiente', createdAt: now });
const jobTk = await esperarTerminal(T, ATT3);
check('4c. takeover humano ⇒ silencio absoluto (skipped, cero mensajes nuevos)', jobTk?.status === 'skipped' && (await outMsgs(T)).length === 1, );

console.log('— 5/5: aislamiento entre tenants —');
const jobsT2 = (await db.collection(`tenants/${T2}/aiVisionJobs`).get()).docs.map((d) => d.data());
check('5. nada del ciclo de T tocó a T2 (su job sigue skipped por SU flag; cero mensajes)',
  jobsT2.every((j) => j.tenantId === T2) && (await outMsgs(T2)).length === 0);

console.log(`\nRESULTADO AI-VISION (visión de productos): ${fail === 0 ? 'TODO OK ✅' : 'FALLAS ❌'} (${ok}/${ok + fail})`);
process.exit(fail === 0 ? 0 : 1);
