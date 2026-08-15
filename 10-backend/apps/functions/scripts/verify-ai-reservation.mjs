/**
 * verify-ai-reservation.mjs — E2E de la reserva transaccional de cuota IA (ADR-0018)
 * ==================================================================================
 * CONCURRENCIA REAL contra el emulador de Firestore (transacciones de verdad, no mocks):
 * procesos paralelos compitiendo por la misma capacidad y por la misma clave. La sección 7
 * (integración Fase 2) maneja el TRIGGER REAL `onWebhookInbox` — requiere el emulador de
 * FUNCTIONS además de firestore (+auth+storage), como verify-ai-vision.
 * Requiere: emulador (functions+firestore+auth+storage, --project demo-aiafg) + build fresco (lib/).
 *
 *   node scripts/verify-ai-reservation.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.GCLOUD_PROJECT ??= 'demo-aiafg';
// getConfig() valida el env completo: cargar .env.local sin pisar lo ya seteado.
const envLocal = join(raiz, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const { initializeApp, getApps } = await import('firebase-admin/app');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
if (!getApps().length) initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore();

const { reservarTurnoDeIa, runAiReservationSweep, AI_RESERVATION_LEASE_MS } = await import(
  new URL('../lib/entitlements/aiReservation.js', import.meta.url).href
);

let ok = 0, fail = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✅ ${nombre}`); }
  else { fail++; console.log(`  ❌ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};

const T1 = 'e2e_reserva_a';
const T2 = 'e2e_reserva_b';
const now = Timestamp.now();

async function sembrarPlan(id, maxAiTokensPerMonth) {
  await db.doc(`plans/${id}`).set({
    id, tier: id.toUpperCase(), name: id, description: 'e2e', priceUsdPerMonth: 0, pricePygPerMonth: 0,
    limits: { maxProducts: 100, maxOrdersPerMonth: 100, maxWhatsappMessagesPerMonth: 1000, maxDeliveryPersons: 5, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth },
    features: { aiAssistant: true, marketingAutomation: false },
  });
}
async function sembrarTenant(t, planId) {
  await db.doc(`tenants/${t}`).set({
    id: t, name: t, planId, status: 'ACTIVE', isDemo: false,
    subscription: { status: 'none', planId },
    usage: { aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, aiTokensReserved: 0, ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, currentPeriodStart: now },
    createdAt: now, updatedAt: now,
  });
}

// Limpieza previa (ids propios de este script; idempotente).
for (const t of [T1, T2]) {
  const res = await db.collection(`tenants/${t}/aiReservations`).get();
  for (const d of res.docs) await d.ref.delete();
  const nots = await db.collection(`tenants/${t}/notifications`).get();
  for (const d of nots.docs) await d.ref.delete();
}
await sembrarPlan('e2e-starter', 3_000);
await sembrarPlan('free', 0);
await sembrarTenant(T1, 'e2e-starter');
await sembrarTenant(T2, 'e2e-starter');

const usageDe = async (t) => (await db.doc(`tenants/${t}`).get()).data().usage;
const CTX = { context: 'whatsapp_sales_agent' };

console.log('— 1/7: misma clave en paralelo —');
const [a, b] = await Promise.all([
  reservarTurnoDeIa(T1, 'ventas-mismawamid', 1000, CTX),
  reservarTurnoDeIa(T1, 'ventas-mismawamid', 1000, CTX),
]);
let u = await usageDe(T1);
check('1. dos procesos, misma clave ⇒ UNA reserva (reservado=1000, ningún handle cerrado)',
  u.aiTokensReserved === 1000 && !a.cerrada && !b.cerrada, `reservado=${u.aiTokensReserved}`);

console.log('— 2/7: carrera por la capacidad (límite 3000, ya hay 1000) —');
const rs = await Promise.allSettled(
  [1, 2, 3, 4, 5].map((i) => reservarTurnoDeIa(T1, `ventas-carrera${i}`, 900, CTX)),
);
const admitidas = rs.filter((r) => r.status === 'fulfilled').length;
u = await usageDe(T1);
check('2. de 5 reservas de 900 entran EXACTAMENTE 2 (1000+2×900=2800 ≤ 3000) y el agregado no se excede',
  admitidas === 2 && u.aiTokensReserved === 2_800,
  `admitidas=${admitidas} reservado=${u.aiTokensReserved}`);
check('2b. las rechazadas fallan con resource-exhausted',
  rs.filter((r) => r.status === 'rejected').every((r) => r.reason?.code === 'resource-exhausted'));

console.log('— 3/7: liquidación exactamente-una-vez (en paralelo) —');
const [l1, l2] = await Promise.all([
  a.liquidar({ inputTokens: 500, outputTokens: 100 }, 0.01),
  b.liquidar({ inputTokens: 500, outputTokens: 100 }, 0.01),
]);
u = await usageDe(T1);
check('3. dos liquidaciones concurrentes de la MISMA reserva ⇒ una aplica, 600 liquidados, estimación devuelta',
  (l1.aplicada !== l2.aplicada) && u.aiTokensThisMonth === 600 && u.aiTokensReserved === 1_800,
  `aplicadas=${[l1.aplicada, l2.aplicada]} settled=${u.aiTokensThisMonth} reservado=${u.aiTokensReserved}`);

console.log('— 4/7: liberación —');
const admitida = rs.find((r) => r.status === 'fulfilled').value;
await admitida.liberar('proveedor_no_configurado');
u = await usageDe(T1);
check('4. liberar devuelve la capacidad completa (1800−900=900) sin liquidar nada',
  u.aiTokensReserved === 900 && u.aiTokensThisMonth === 600, `reservado=${u.aiTokensReserved}`);

console.log('— 5/7: vencimiento y recuperación —');
const barrido = await runAiReservationSweep({ nowMs: Date.now() + AI_RESERVATION_LEASE_MS + 60_000 });
u = await usageDe(T1);
const vencidasDocs = (await db.collection(`tenants/${T1}/aiReservations`).where('status', '==', 'vencida').get()).size;
check('5. el barrido vence la reserva huérfana restante y devuelve su capacidad (reservado=0)',
  barrido.vencidas >= 1 && u.aiTokensReserved === 0 && vencidasDocs >= 1,
  `vencidas=${barrido.vencidas} reservado=${u.aiTokensReserved}`);

console.log('— 6/7: alertas idempotentes y aislamiento —');
// T2: límite 3000; liquidar 2400 (80%) dos veces con claves distintas ⇒ SOLO el umbral 70, una vez.
const r1 = await reservarTurnoDeIa(T2, 'ventas-alert1', 1200, CTX);
await r1.liquidar({ inputTokens: 1200, outputTokens: 0 }, 0.01);
const r2 = await reservarTurnoDeIa(T2, 'ventas-alert2', 1200, CTX);
await r2.liquidar({ inputTokens: 1200, outputTokens: 0 }, 0.01);
const notsT2 = (await db.collection(`tenants/${T2}/notifications`).get()).docs.map((d) => d.data());
check('6. 2400/3000 (80%) ⇒ exactamente UNA alerta (umbral 70), categoría ai_quota',
  notsT2.length === 1 && notsT2[0].category === 'ai_quota' && notsT2[0].type === 'ai_quota_70',
  `alertas=${notsT2.map((n) => n.type).join(',')}`);
// T1 recibió 3 rechazos por capacidad en el check 2 ⇒ exactamente UNA alerta `agotada`
// (aviso al bloquear, idempotente) — y ninguna de las alertas de T2 se cruzó.
const notsT1 = (await db.collection(`tenants/${T1}/notifications`).get()).docs.map((d) => d.data());
check('6b. aislamiento + aviso al bloquear: T1 tiene SOLO su alerta agotada (1, pese a 3 rechazos) y sus contadores intactos',
  notsT1.length === 1 && notsT1[0].type === 'ai_quota_agotada' && (await usageDe(T1)).aiTokensThisMonth === 600,
  `notsT1=${notsT1.map((n) => n.type).join(',')}`);
const sinPii = [...notsT2, ...notsT1].every((n) => !/\+?\d{9,}|prompt|Bearer|sk-/i.test(`${n.title} ${n.body} ${n.type} ${n.category}`));
check('6c. título/cuerpo de las alertas sin PII, teléfonos, prompts ni secretos', sinPii);

console.log('— 7/7: integración FASE 2 — el webhook REAL reserva por turno de IA y lo determinístico cuesta cero —');
// El trigger onWebhookInbox (LA superficie de la Fase 2) se maneja creando el doc del inbox en
// 'received' con la MISMA forma que escribe webhookHttp (crearEventoInbox). El tenant se resuelve
// por el índice; automationMode va CRUDO en el asset, como lo deja la migración oficial.
const T3 = 'e2e_fase2';
const T4 = 'e2e_fase2_off';
await sembrarPlan('e2e-fase2', 50_000);
await sembrarTenant(T3, 'e2e-fase2');
await sembrarTenant(T4, 'e2e-fase2');
for (const t of [T3, T4]) {
  for (const col of ['aiReservations', 'notifications']) {
    const docs = await db.collection(`tenants/${t}/${col}`).get();
    for (const d of docs.docs) await d.ref.delete();
  }
  const clientes = await db.collection(`tenants/${t}/customers`).get();
  for (const c of clientes.docs) {
    const msgs = await c.ref.collection('messages').get();
    for (const m of msgs.docs) await m.ref.delete();
    const ses = await c.ref.collection('sessions').get();
    for (const s of ses.docs) await s.ref.delete();
    await c.ref.delete();
  }
}
// Número LIVE de T3 (asset manda; canal heredado) y número SIN automationMode de T4.
await db.doc(`tenants/${T3}/metaAssets/pnf2live`).set({ id: 'pnf2live', tenantId: T3, assetType: 'whatsapp_phone_number', externalId: 'pnf2live', connectionId: 'main', status: 'active', selected: true, automationMode: 'live' });
await db.doc('metaExternalIndex/whatsapp_pnf2live').set({ id: 'whatsapp_pnf2live', tenantId: T3, connectionId: 'main', externalId: 'pnf2live', platform: 'whatsapp', status: 'active' });
await db.doc(`tenants/${T4}/metaAssets/pnf2off`).set({ id: 'pnf2off', tenantId: T4, assetType: 'whatsapp_phone_number', externalId: 'pnf2off', connectionId: 'main', status: 'active', selected: true });
await db.doc('metaExternalIndex/whatsapp_pnf2off').set({ id: 'whatsapp_pnf2off', tenantId: T4, connectionId: 'main', externalId: 'pnf2off', platform: 'whatsapp', status: 'active' });
// FakeAiClient: una respuesta de texto con uso conocido (real = 2100+180 = 2280).
await db.doc('aiTestFixtures/ai').set({ text: 'Un EDP concentra más esencia que un EDT y suele durar más en la piel.', inputTokens: 2100, outputTokens: 180 });

const inboxDoc = (externalId, wamid, texto, from) => ({
  id: `whatsapp_${wamid}`, platform: 'whatsapp', objectType: 'message', eventType: 'messages',
  externalId, tenantId: null, kind: 'message', processingStatus: 'received',
  payload: { from, messageId: wamid, text: texto, profileName: 'Cliente F2' },
  errorMessage: '', receivedAt: Timestamp.now(), processedAt: null,
  expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
});
const esperarTerminal = async (wamid, maxMs = 25_000) => {
  const ref = db.doc(`metaWebhookInbox/whatsapp_${wamid}`);
  const fin = Date.now() + maxMs;
  for (;;) {
    const d = (await ref.get()).data();
    if (d && d.processingStatus !== 'received' && d.processingStatus !== 'processing') return d;
    if (Date.now() > fin) return d ?? null;
    await new Promise((r) => setTimeout(r, 400));
  }
};
const salidasDe = async (t, cid) => (await db.collection(`tenants/${t}/customers/${cid}/messages`).get()).docs
  .map((d) => d.data()).filter((m) => m.direction === 'out');

// A) Turno DETERMINÍSTICO por el webhook real ⇒ respuesta sí, reserva NO.
await db.doc('metaWebhookInbox/whatsapp_wamid_f2_det').set(inboxDoc('pnf2live', 'wamid_f2_det', 'hola', '595000000021'));
const evA = await esperarTerminal('wamid_f2_det');
const outsA = await salidasDe(T3, '595000000021');
const resvA = (await db.collection(`tenants/${T3}/aiReservations`).get()).size;
check('7a. determinístico por el webhook: processed, respuesta del bot y CERO reservas',
  evA?.processingStatus === 'processed' && outsA.length >= 1 && resvA === 0,
  `status=${evA?.processingStatus} outs=${outsA.length} reservas=${resvA}`);

// B) Turno de IA por el webhook real ⇒ reserva ventas-* liquidada con el uso REAL y espejo en 0.
await db.doc('metaWebhookInbox/whatsapp_wamid_f2_ia').set(inboxDoc('pnf2live', 'wamid_f2_ia', '¿qué diferencia hay entre un edp y un edt?', '595000000021'));
const evB = await esperarTerminal('wamid_f2_ia');
const resvDocs = (await db.collection(`tenants/${T3}/aiReservations`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const rVentas = resvDocs.filter((r) => r.id.startsWith('ventas-'));
const uT3 = await usageDe(T3);
const outsB = (await salidasDe(T3, '595000000021')).filter((m) => /EDP concentra/.test(m.text ?? ''));
check('7b. turno de IA por el webhook: UNA reserva ventas-*, liquidada con el uso real (2280)',
  evB?.processingStatus === 'processed' && rVentas.length === 1 && rVentas[0].status === 'liquidada' && rVentas[0].actualTokens === 2_280,
  `status=${evB?.processingStatus} reservas=${resvDocs.map((r) => `${r.id.slice(0, 14)}:${r.status}:${r.actualTokens}`).join(',')}`);
check('7c. espejo reservado de vuelta en CERO y el mes registra el uso real',
  uT3.aiTokensReserved === 0 && uT3.aiTokensThisMonth === 2_280,
  `reservado=${uT3.aiTokensReserved} mes=${uT3.aiTokensThisMonth}`);
check('7d. la respuesta de la IA llegó al cliente (texto del fixture)', outsB.length === 1, `outs=${outsB.length}`);

// C) automationMode AUSENTE ⇒ fail-closed: sin respuesta y sin reserva (el gate de ADR-0017 manda).
await db.doc('metaWebhookInbox/whatsapp_wamid_f2_off').set(inboxDoc('pnf2off', 'wamid_f2_off', 'hola', '595000000041'));
const evC = await esperarTerminal('wamid_f2_off');
const outsC = await salidasDe(T4, '595000000041');
const resvC = (await db.collection(`tenants/${T4}/aiReservations`).get()).size;
check('7e. modo AUSENTE: el evento cierra IGNORADO por el gate (no por crash), sin respuesta y sin reserva',
  evC?.processingStatus === 'ignored' && outsC.length === 0 && resvC === 0,
  `status=${evC?.processingStatus} outs=${outsC.length} reservas=${resvC}`);

console.log(`\nRESULTADO AI-RESERVATION (reserva de cuota IA): ${fail === 0 ? 'TODO OK ✅' : 'FALLAS ❌'} (${ok}/${ok + fail})`);
process.exit(fail === 0 ? 0 : 1);
