/**
 * verify-coverage-killswitch.mjs — COVERAGE-KILL-SWITCH-ATOMICITY-1 end-to-end (emulador limpio).
 * El apagado de emergencia (enabled=false o rotación de activationId) que COMMITEA antes de cada
 * punto de decisión gana SIEMPRE: se pausa la ejecución en 9 checkpoints reales (hooks
 * solo-emulador), se cambia el flag y se verifica que la validación EN-TRANSACCIÓN posterior
 * no crea solicitudes, no guarda ubicación, no hace handoff, no libera chats, no crea órdenes,
 * no muestra banco y no llama a Meta. El camino con flag intacto sigue funcionando igual.
 *
 * Requiere: emulador (auth+functions+firestore) + seed-users + load-catalog (tenant perfumeria).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const PNID = '900000000000105';
const FIX = 'aiTestFixtures/ai';
const LAT = -25.32222;
const LNG = -57.62222;
const ACT = 'act-e2e-kill-000001';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null };
}

let mid = 0;
const wa = (from, messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
  contacts: [{ wa_id: from, profile: { name: 'Cliente KS' } }], messages,
} }] }] });
const postText = (from, body, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.KS-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }])) });
const postLocation = (from, loc, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.KSLOC-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'location', location: loc }])) });

const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const outsCount = async (c) => (await msgsOf(c)).filter((m) => m.direction === 'out').length;
const outsCon = async (c, s) => (await msgsOf(c)).filter((m) => m.direction === 'out' && (m.text ?? '').includes(s)).length;
const lastOut = async (c) => { const o = (await msgsOf(c)).filter((m) => m.direction === 'out'); return o.length ? o[o.length - 1].text : null; };
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const requestOf = async (c) => {
  const snap = await db.collection(`tenants/${T}/coverageRequests`).where('customerId', '==', c).get();
  const reqs = snap.docs.map((d) => d.data()).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  return reqs[0] ?? null;
};
const jobOf = async (id) => (await db.doc(`tenants/${T}/coverageResumeJobs/${id}`).get()).data() ?? null;
const outboxDe = async (reqId) => (await db.collection(`tenants/${T}/coverageMessageOutbox`).get()).docs
  .map((d) => d.data()).filter((m) => m.coverageRequestId === reqId);
const ordersOf = async (c) => (await db.collection(`tenants/${T}/orders`).where('customerId', '==', c).get()).docs.map((d) => d.data());
const notifsDe = async (c) => (await db.collection(`tenants/${T}/notifications`).get()).docs.map((d) => d.data()).filter((n) => n.customerId === c);
const waitFor = async (pred, maxMs = 20000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(500); } return false; };
const sendAndWait = async (from, text, maxMs = 15000) => { const antes = await outsCount(from); await postText(from, text); const ok = await waitFor(async () => (await outsCount(from)) > antes, maxMs); return ok ? lastOut(from) : null; };
const armarCarrito = async (from) => {
  await postText(from, 'hola');
  await waitFor(async () => (await outsCount(from)) > 0);
  await sendAndWait(from, 'agregá la belle');
};
const crearPendiente = async (from) => {
  await armarCarrito(from);
  await sendAndWait(from, 'quiero pagar');
  await postLocation(from, { latitude: LAT, longitude: LNG, address: 'Av. Kill 555, Luque' });
  await waitFor(async () => (await requestOf(from))?.status === 'pending_coverage_review');
  return requestOf(from);
};

// Hooks del kill-switch (solo-emulador): setHold → acción → waitHold → cambiar flag → release.
const FXH = `tenants/${T}/_debug/coverageFixtures`;
const HOLDS = `tenants/${T}/_debug/coverageHolds`;
const setHold = (point) => db.doc(FXH).set({ holdAt: point });
const waitHold = (point) => waitFor(async () => (await db.doc(HOLDS).get()).data()?.point === point, 20000);
const release = () => db.doc(FXH).set({ resume: true }, { merge: true });
const clearHold = async () => { await db.doc(FXH).delete().catch(() => {}); await db.doc(HOLDS).delete().catch(() => {}); };

const setCoverage = (coverage) => db.doc(`tenants/${T}/config/checkout`).set({
  sellers: [{ name: 'Vendedor KS', whatsapp: '595991000015', active: true }],
  bankAccounts: [{ bank: 'Banco KS', accountNumber: '000-5', holder: 'Titular KS', document: '5555' }],
  ...(coverage !== undefined ? { coverage } : {}),
});
const prender = () => setCoverage({ enabled: true, expiryHours: 24, activationId: ACT });
const apagar = () => setCoverage({ enabled: false });

// ---- Snapshot + setup ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;
const now0 = Timestamp.now();
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot KS' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now0 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now0 },
}, { merge: true });
await db.doc(FIX).set({ text: 'Respuesta IA [fixture-ks]' });
await prender();

const superadmin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', superadmin, {
  tenantId: T, wabaId: 'WABA-KS', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 105',
  businessName: 'KS Test', accessToken: 'tok-ks-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });
const owner = await signIn('owner@perfumeria.com');

const CUST = (n) => `59599430${String(n).padStart(4, '0')}`;
const limpiar = async () => {
  for (const coll of ['coverageRequests', 'coverageResumeJobs', 'coverageMessageOutbox']) {
    const snap = await db.collection(`tenants/${T}/${coll}`).get();
    for (const d of snap.docs) { if (String(d.data().customerId ?? '').startsWith('59599430')) await d.ref.delete().catch(() => {}); }
  }
  const notifs = await db.collection(`tenants/${T}/notifications`).get();
  for (const d of notifs.docs) { if (String(d.data().customerId ?? '').startsWith('59599430')) await d.ref.delete().catch(() => {}); }
  for (let i = 1; i <= 12; i++) await db.doc(`tenants/${T}/customers/${CUST(i)}/sessions/active`).delete().catch(() => {});
  await clearHold();
};
await limpiar();

try {

// ===== 1. gate_pre_tx: OFF commiteado antes del claim del gate → checkout TRADICIONAL =====
const C1 = CUST(1);
await armarCarrito(C1);
await setHold('gate_pre_tx');
const outsAntes1 = await outsCount(C1);
postText(C1, 'quiero pagar');
check('1a. el flujo llegó al checkpoint del gate (hold alcanzado)', await waitHold('gate_pre_tx'));
await apagar();
await release();
await waitFor(async () => (await outsCount(C1)) > outsAntes1);
check('1. gate: kill-switch en la transacción → CERO coverageRequests y el checkout tradicional sigue (orden + banco)',
  (await requestOf(C1)) === null && (await ordersOf(C1)).length === 1 && (await outsCon(C1, 'transferir')) === 1,
  `reqs=${(await requestOf(C1)) ? 1 : 0} orders=${(await ordersOf(C1)).length}`);
await clearHold();
await prender();

// ===== 1b. reply_pre_send: el gate creó el request VIGENTE, el flag cae antes del envío físico
// del location request → NO se llama a Meta (el mensaje más sensible: pide PII para un flujo
// que el owner acaba de apagar). El request queda creado (inerte). =====
const C1b = CUST(11);
await armarCarrito(C1b);
const traceRef = db.doc(`tenants/${T}/_debug/lastWhatsappSend`);
const atAntes1b = ((await traceRef.get()).data()?.at?.toMillis?.()) ?? 0;
await setHold('reply_pre_send');
postText(C1b, 'quiero pagar');
check('1b-a. el flujo llegó al checkpoint pre-envío (request ya creado)', await waitHold('reply_pre_send'));
await apagar();
await release();
await sleep(3500);
const trace1b = (await traceRef.get()).data() ?? {};
const locReqEnviado = trace1b.kind === 'location_request' && trace1b.to === C1b && ((trace1b.at?.toMillis?.() ?? 0) > atAntes1b);
check('1b. reply de cobertura: kill-switch antes del envío → NO se manda el location request a Meta; el request quedó creado inerte',
  (await requestOf(C1b))?.status === 'awaiting_location' && !locReqEnviado && (await ordersOf(C1b)).length === 0,
  `locReqEnviado=${locReqEnviado} trace=${trace1b.kind}`);
await clearHold();
await prender();

// ===== 2. ubicacion_pre_tx: OFF antes de la transacción de registro → nada sensible persiste =====
const C2 = CUST(2);
await armarCarrito(C2);
await sendAndWait(C2, 'quiero pagar'); // awaiting_location bajo ACT
await setHold('ubicacion_pre_tx');
postLocation(C2, { latitude: LAT, longitude: LNG, address: 'Av. Privadísima 999' });
check('2a. el flujo llegó al checkpoint de registro (hold alcanzado)', await waitHold('ubicacion_pre_tx'));
await apagar();
await release();
await waitFor(async () => ((await lastOut(C2)) ?? '').includes('no puedo procesarla'));
const r2 = await requestOf(C2);
check('2. ubicación: kill-switch en la transacción → sin dirección/coords/fingerprint/seller; sin handoff ni campana; respuesta honesta',
  r2?.status === 'awaiting_location' && r2?.location === null && r2?.locationFingerprint === null && (r2?.sellerUid ?? null) === null &&
  (await sessionOf(C2))?.context?.humanTakeover !== true && (await notifsDe(C2)).length === 0 &&
  (await outsCon(C2, 'no puedo procesarla')) >= 1 && // respuesta honesta REALMENTE entregada
  !(await msgsOf(C2)).some((m) => /Privadísima|25\.32|57\.62/.test(m.text ?? '')),
  `status=${r2?.status} loc=${JSON.stringify(r2?.location)}`);
await clearHold();
await prender();

// ===== 3. pre_handoff: la ubicación persistió VIGENTE, el flag cae antes del handoff =====
const C3 = CUST(3);
await armarCarrito(C3);
await sendAndWait(C3, 'quiero pagar');
await setHold('pre_handoff');
postLocation(C3, { latitude: LAT, longitude: LNG, address: 'Av. Kill 777' });
check('3a. el flujo llegó al checkpoint pre-handoff (ubicación ya persistida)', await waitHold('pre_handoff'));
await apagar();
await release();
await waitFor(async () => ((await lastOut(C3)) ?? '').includes('no puedo procesarla'));
const r3 = await requestOf(C3);
check('3. handoff: guard transaccional lo bloquea → ubicación guardada pero SIN takeover, SIN campana, sin promesa de revisión',
  r3?.status === 'pending_coverage_review' && r3?.location?.addressText === 'Av. Kill 777' &&
  (await sessionOf(C3))?.context?.humanTakeover !== true && (await notifsDe(C3)).length === 0 &&
  (await outsCon(C3, 'no puedo procesarla')) >= 1 && // respuesta neutra honesta entregada (sin promesa)
  !(await msgsOf(C3)).some((m) => (m.text ?? '').includes('va a confirmar la cobertura')) && // NUNCA la promesa de revisión
  (await ordersOf(C3)).length === 0,
  `status=${r3?.status} takeover=${(await sessionOf(C3))?.context?.humanTakeover}`);
await clearHold();
await prender();

// ===== 4. resume_pre_liberar: job reclamado, OFF antes de liberar el takeover =====
const C4 = CUST(4);
const r4 = await crearPendiente(C4);
await setHold('resume_pre_liberar');
await call('coverageApprove', owner, { tenantId: T, requestId: r4.id, expectedFingerprint: r4.locationFingerprint });
check('4a. el consumidor llegó al checkpoint pre-liberación (job reclamado)', await waitHold('resume_pre_liberar'));
await apagar();
await release();
await waitFor(async () => (await jobOf(r4.id))?.status === 'pending');
const ses4 = await sessionOf(C4);
check('4. liberación: kill-switch en la transacción → takeover INTACTO, job en espera segura, cero orden/banco, marca limpia',
  (await jobOf(r4.id))?.status === 'pending' && ses4?.context?.humanTakeover === true &&
  ses4?.context?.handoffReason === 'coverage_review' && (ses4?.context?.coverageResumeInProgress ?? null) === null &&
  (await ordersOf(C4)).length === 0 && (await outsCon(C4, 'transferir')) === 0,
  `job=${(await jobOf(r4.id))?.status} takeover=${ses4?.context?.handoffReason}`);
await clearHold();
await prender();

// ===== 5. resume_pre_orden: liberado VIGENTE, OFF antes de crear la orden =====
const C5 = CUST(5);
const r5 = await crearPendiente(C5);
await setHold('resume_pre_orden');
await call('coverageApprove', owner, { tenantId: T, requestId: r5.id, expectedFingerprint: r5.locationFingerprint });
check('5a. el consumidor llegó al checkpoint pre-orden', await waitHold('resume_pre_orden'));
await apagar();
await release();
await waitFor(async () => (await jobOf(r5.id))?.status === 'pending');
check('5. orden: la precondición DENTRO de la transacción de creación la frena → CERO orden/finanzas/banco; job en espera; marca limpia',
  (await jobOf(r5.id))?.status === 'pending' && (await ordersOf(C5)).length === 0 &&
  (await outsCon(C5, 'transferir')) === 0 && ((await sessionOf(C5))?.context?.coverageResumeInProgress ?? null) === null,
  `job=${(await jobOf(r5.id))?.status} orders=${(await ordersOf(C5)).length}`);
await clearHold();
await prender();

// ===== 6. resume_pre_awaiting: orden creada VIGENTE, OFF antes de AWAITING_PAYMENT =====
const C6 = CUST(6);
const r6 = await crearPendiente(C6);
await setHold('resume_pre_awaiting');
await call('coverageApprove', owner, { tenantId: T, requestId: r6.id, expectedFingerprint: r6.locationFingerprint });
check('6a. el consumidor llegó al checkpoint pre-AWAITING (orden ya creada)', await waitHold('resume_pre_awaiting'));
await apagar();
await release();
await waitFor(async () => (await jobOf(r6.id))?.status === 'pending');
const ses6 = await sessionOf(C6);
check('6. AWAITING: kill-switch en la transacción → la sesión NO pasa a AWAITING_PAYMENT, cero banco; la orden creada queda (sin mensaje) y el job en espera',
  (await jobOf(r6.id))?.status === 'pending' && (await ordersOf(C6)).length === 1 &&
  ses6?.state !== 'AWAITING_PAYMENT' && (ses6?.context?.coverageResumeInProgress ?? null) === null &&
  (await outsCon(C6, 'transferir')) === 0,
  `state=${ses6?.state} orders=${(await ordersOf(C6)).length}`);
await clearHold();

// ===== 6b. Reactivación con la MISMA activación → el job pausado converge: MISMA orden, UNA instrucción =====
await prender();
await db.doc(`tenants/${T}/coverageResumeJobs/${r6.id}`).update({ status: 'processing', updatedAt: Timestamp.now() });
await db.doc(`tenants/${T}/coverageResumeJobs/${r6.id}`).update({ status: 'pending', updatedAt: Timestamp.now() });
await waitFor(async () => (await jobOf(r6.id))?.status === 'done');
check('6b. re-encendido (misma activación) → el job pausado completa: MISMA orden única, UNA instrucción, AWAITING_PAYMENT',
  (await jobOf(r6.id))?.status === 'done' && (await ordersOf(C6)).length === 1 &&
  (await outsCon(C6, 'transferir')) === 1 && (await sessionOf(C6))?.state === 'AWAITING_PAYMENT',
  `job=${(await jobOf(r6.id))?.status} outs=${await outsCon(C6, 'transferir')}`);

// ===== 7. outbox_pre_claim: AWAITING persistido VIGENTE, OFF antes de reclamar el outbox =====
const C7 = CUST(7);
const r7 = await crearPendiente(C7);
await setHold('outbox_pre_claim');
await call('coverageApprove', owner, { tenantId: T, requestId: r7.id, expectedFingerprint: r7.locationFingerprint });
check('7a. el consumidor llegó al checkpoint pre-claim del outbox', await waitHold('outbox_pre_claim'));
await apagar();
await release();
await waitFor(async () => (await jobOf(r7.id))?.status === 'pending');
check('7. outbox: kill-switch en el claim → mensaje NI preparado NI reclamado, cero outbound bancario; job en espera',
  (await jobOf(r7.id))?.status === 'pending' && (await outboxDe(r7.id)).length === 0 &&
  (await outsCon(C7, 'transferir')) === 0 && (await ordersOf(C7)).length === 1,
  `outbox=${(await outboxDe(r7.id)).length}`);
await clearHold();
await prender();

// ===== 8. outbox_pre_meta: outbox reclamado (sending), OFF inmediatamente antes de llamar a Meta =====
const C8 = CUST(8);
const r8 = await crearPendiente(C8);
await setHold('outbox_pre_meta');
await call('coverageApprove', owner, { tenantId: T, requestId: r8.id, expectedFingerprint: r8.locationFingerprint });
check('8a. el consumidor llegó al checkpoint pre-Meta (outbox ya reclamado)', await waitHold('outbox_pre_meta'));
await apagar();
await release();
await waitFor(async () => (await jobOf(r8.id))?.status === 'pending');
const ob8 = (await outboxDe(r8.id)).find((m) => m.action === 'approved');
check('8. pre-Meta: re-chequeo inmediato → CERO llamada a Meta (sin mensaje), outbox degradado a prepared, job en espera',
  (await jobOf(r8.id))?.status === 'pending' && ob8?.status === 'prepared' && ob8?.providerMessageId === null &&
  (await outsCon(C8, 'transferir')) === 0,
  `outbox=${ob8?.status}`);
await clearHold();
await prender();

// ===== 9. mant_pre_reencolar: held_by_seller + OFF después de la lectura inicial del mantenimiento.
// El job held se SIEMBRA directo (determinístico: sin carreras con el re-drive de chatRelease). =====
const C9 = CUST(9);
const r9 = await crearPendiente(C9);
await call('coverageApprove', owner, { tenantId: T, requestId: r9.id, expectedFingerprint: r9.locationFingerprint });
await waitFor(async () => (await jobOf(r9.id))?.status === 'done'); // se procesó normal…
// …ahora se fuerza el estado held_by_seller (como si un takeover ajeno lo hubiera retenido),
// con la sesión SIN takeover para que el re-driver del mantenimiento intente re-encolarlo.
await db.doc(`tenants/${T}/coverageResumeJobs/${r9.id}`).update({ status: 'held_by_seller', leaseUntil: null, updatedAt: Timestamp.now() });
await db.doc(`tenants/${T}/coverageRequests/${r9.id}`).update({ resume: { status: 'held_by_seller', orderId: (await jobOf(r9.id))?.orderId ?? null } });
await db.doc(`tenants/${T}/customers/${C9}/sessions/active`).update({ 'context.humanTakeover': false, 'context.handoffReason': null });
await setHold('mant_pre_reencolar');
fetch(`${BASE}/devRunCoverageMaintenance`);
check('9a. el mantenimiento llegó al checkpoint pre-reencolado', await waitHold('mant_pre_reencolar'));
await apagar();
await release();
await sleep(4000);
check('9. mantenimiento: kill-switch re-leído en la transacción del re-drive → el job held NO se re-encola',
  (await jobOf(r9.id))?.status === 'held_by_seller',
  `job=${(await jobOf(r9.id))?.status}`);
await clearHold();
await prender();

// ===== 10. Camino NORMAL sin cambios de flag (los hooks no distorsionan) =====
const C10 = CUST(10);
const r10 = await crearPendiente(C10);
await call('coverageApprove', owner, { tenantId: T, requestId: r10.id, expectedFingerprint: r10.locationFingerprint });
await waitFor(async () => (await jobOf(r10.id))?.status === 'done');
check('10. flag intacto → flujo completo normal: orden única + instrucción única + AWAITING_PAYMENT + bot liberado',
  (await jobOf(r10.id))?.status === 'done' && (await ordersOf(C10)).length === 1 &&
  (await outsCon(C10, 'transferir')) === 1 && (await sessionOf(C10))?.state === 'AWAITING_PAYMENT' &&
  (await sessionOf(C10))?.context?.humanTakeover === false);

// ===== 11. Cero efectos cross-tenant en toda la corrida =====
const otroReqs = await db.collection('tenants/otro-tenant/coverageRequests').get();
const otroJobs = await db.collection('tenants/otro-tenant/coverageResumeJobs').get();
check('11. aislamiento: ningún artefacto de cobertura apareció en otro tenant',
  otroReqs.size === 0 && otroJobs.size === 0);

} finally {
  await clearHold();
  for (let i = 1; i <= 12; i++) await call('chatRelease', owner, { tenantId: T, customerId: CUST(i) }).catch(() => {});
  await limpiar();
  await db.doc(FIX).delete().catch(() => {});
  await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
  await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
  await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
  await db.doc(`tenants/${T}`).set(beforeTenant);
  if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
  if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
  if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO COVERAGE-KILL-SWITCH (apagado atómico): ${ok ? `TODO OK ✅ (${results.length}/${results.length})` : `FALLOS ❌ (${results.filter(Boolean).length}/${results.length})`}`);
process.exit(ok ? 0 : 1);
