/**
 * verify-coverage-review.mjs — COVERAGE-1C end-to-end (emulador limpio).
 * Revisión humana de cobertura: callables (aprobar/rechazar/pedir info) con autorización por rol
 * y asignación, transacciones (doble clic, fingerprint actualizado, expirado), outbox 1D creado
 * exactamente una vez, Rules de coverageRequests/notifications, y el gap de actualización de
 * ubicación DURANTE la revisión. El feature flag solo se enciende acá (emulador).
 *
 * Requiere: emulador (auth+functions+firestore) + seed-users + load-catalog (tenant perfumeria).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const adminAuth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const T = 'perfumeria';
const PNID = '900000000000103';
const FIX = 'aiTestFixtures/ai';
const LAT = -25.30001;
const LNG = -57.60002;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null };
}
const restGet = async (token, path) => (await fetch(`${FS}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).status;
const restPatch = async (token, path, fields, mask = 'sellerUid') =>
  (await fetch(`${FS}/${path}?updateMask.fieldPaths=${mask}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ fields }) })).status;
// LIST evaluada por RULES con token de usuario (la semántica query-vs-rules del panel real).
const restRunQuery = async (token, parent, structuredQuery) =>
  fetch(`${FS}/${parent}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ structuredQuery }) });

let mid = 0;
const wa = (from, messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
  contacts: [{ wa_id: from, profile: { name: 'Cliente CR' } }], messages,
} }] }] });
const postText = (from, body, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.CR-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }])) });
const postLocation = (from, loc, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.CRLOC-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'location', location: loc }])) });

const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const outsCount = async (c) => (await msgsOf(c)).filter((m) => m.direction === 'out').length;
const lastOut = async (c) => { const o = (await msgsOf(c)).filter((m) => m.direction === 'out'); return o.length ? o[o.length - 1].text : null; };
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const requestOf = async (c) => {
  const snap = await db.collection(`tenants/${T}/coverageRequests`).where('customerId', '==', c).get();
  const reqs = snap.docs.map((d) => d.data()).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  return reqs[0] ?? null;
};
const jobOf = async (requestId) => (await db.doc(`tenants/${T}/coverageResumeJobs/${requestId}`).get()).data() ?? null;
const ordersOf = async (c) => (await db.collection(`tenants/${T}/orders`).where('customerId', '==', c).get()).size;
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };
const sendAndWait = async (from, text, maxMs = 15000) => { const antes = await outsCount(from); await postText(from, text); const ok = await waitFor(async () => (await outsCount(from)) > antes, maxMs); return ok ? lastOut(from) : null; };
const armarCarrito = async (from) => {
  await postText(from, 'hola');
  await waitFor(async () => (await outsCount(from)) > 0);
  await sendAndWait(from, 'agregá la belle');
};
/** Carrito → pagar → ubicación nativa → request pending_coverage_review. */
const crearPendiente = async (from, sellerUid = null, sellerName = null) => {
  if (sellerUid) await db.doc(`tenants/${T}/customers/${from}`).set({ id: from, tenantId: T, assignedSellerId: sellerUid, assignedSellerName: sellerName }, { merge: true });
  await armarCarrito(from);
  await sendAndWait(from, 'quiero pagar');
  await postLocation(from, { latitude: LAT, longitude: LNG });
  await waitFor(async () => (await requestOf(from))?.status === 'pending_coverage_review');
  return requestOf(from);
};

// ---- Snapshot + setup ----
const beforeTenant = (await db.doc(`tenants/${T}`).get()).data() ?? {};
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeAgent = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;
const now0 = Timestamp.now();
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot CR' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now0 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now0 },
}, { merge: true });
await db.doc(FIX).set({ text: 'Respuesta IA [fixture-cr]' });
await db.doc(`tenants/${T}/config/checkout`).set({
  sellers: [{ name: 'Vendedor CR', whatsapp: '595991000013', active: true }],
  bankAccounts: [{ bank: 'Banco CR', accountNumber: '000-2', holder: 'Titular CR', document: '2222' }],
  coverage: { enabled: true, expiryHours: 24 },
});

const superadmin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', superadmin, {
  tenantId: T, wabaId: 'WABA-CR', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 103',
  businessName: 'CR Test', accessToken: 'tok-cr-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });

// Usuarios: owner y seller ya sembrados; crear manager y un segundo seller con claims.
const ensureUser = async (email, role) => {
  let user;
  try { user = await adminAuth.getUserByEmail(email); } catch { user = await adminAuth.createUser({ email, password: 'test1234' }); }
  await adminAuth.setCustomUserClaims(user.uid, { tenantId: T, role });
  return user.uid;
};
const seller1Uid = (await adminAuth.getUserByEmail('seller@perfumeria.com')).uid;
await ensureUser('manager@perfumeria.com', 'TENANT_MANAGER');
const seller2Uid = await ensureUser('seller2@perfumeria.com', 'SELLER');
const owner = await signIn('owner@perfumeria.com');
const manager = await signIn('manager@perfumeria.com');
const seller1 = await signIn('seller@perfumeria.com');
const seller2 = await signIn('seller2@perfumeria.com');

const CUST = (n) => `59599410${String(n).padStart(4, '0')}`;

// Limpieza INICIAL (re-ejecutabilidad): sobras de corridas anteriores de ESTE script.
const limpiarClientes = async () => {
  const reqs = await db.collection(`tenants/${T}/coverageRequests`).get();
  for (const d of reqs.docs) { if (String(d.data().customerId ?? '').startsWith('59599410')) await d.ref.delete().catch(() => {}); }
  const jobs = await db.collection(`tenants/${T}/coverageResumeJobs`).get();
  for (const d of jobs.docs) { if (String(d.data().customerId ?? '').startsWith('59599410')) await d.ref.delete().catch(() => {}); }
  const notifs = await db.collection(`tenants/${T}/notifications`).get();
  for (const d of notifs.docs) { if (String(d.data().customerId ?? '').startsWith('59599410')) await d.ref.delete().catch(() => {}); }
  for (let i = 1; i <= 14; i++) await db.doc(`tenants/${T}/customers/${CUST(i)}/sessions/active`).delete().catch(() => {});
};
await limpiarClientes();

try {

// ===== 1. Owner aprueba: decisión + fingerprint + outbox una vez; SIN liberar/orden/banco =====
const C1 = CUST(1);
const r1 = await crearPendiente(C1);
const outsAntes1 = await outsCount(C1);
const a1 = await call('coverageApprove', owner, { tenantId: T, requestId: r1.id, expectedFingerprint: r1.locationFingerprint });
await sleep(1500); // asentamiento: ningún mensaje en vuelo debe llegar tras la decisión
const r1b = await requestOf(C1);
const job1 = await jobOf(r1.id);
check('1. owner aprueba → coverage_approved con decision (actor/rol/fingerprint) y resume pending',
  a1.result?.ok === true && r1b.status === 'coverage_approved' && r1b.decision?.action === 'approved' &&
  r1b.decision?.byRole === 'TENANT_OWNER' && r1b.decision?.locationFingerprint === r1.locationFingerprint &&
  r1b.resume?.status === 'pending',
  `status=${r1b?.status} err=${a1.err}`);
check('2. outbox creado EXACTAMENTE una vez (doc-id = requestId, action approved, pending)',
  job1?.action === 'approved' && job1?.status === 'pending' && job1?.coverageRequestId === r1.id);
check('3. la decisión NO libera el chat, NO crea orden, NO manda banco ni mensajes',
  (await sessionOf(C1))?.context?.humanTakeover === true && (await ordersOf(C1)) === 0 &&
  (await outsCount(C1)) === outsAntes1 && !((await lastOut(C1)) ?? '').includes('transferir'));

// ===== 4. Doble clic / segunda decisión → failed-precondition =====
const a1x = await call('coverageApprove', owner, { tenantId: T, requestId: r1.id, expectedFingerprint: r1.locationFingerprint });
const a1y = await call('coverageReject', owner, { tenantId: T, requestId: r1.id, expectedFingerprint: r1.locationFingerprint });
check('4. segunda decisión (approve o reject) → FAILED_PRECONDITION, sin segundo job',
  a1x.err === 'FAILED_PRECONDITION' && a1y.err === 'FAILED_PRECONDITION' && (await jobOf(r1.id))?.action === 'approved');

// ===== 5. approve + reject CONCURRENTES → un solo ganador =====
const C2 = CUST(2);
const r2 = await crearPendiente(C2);
const [c2a, c2b] = await Promise.all([
  call('coverageApprove', owner, { tenantId: T, requestId: r2.id, expectedFingerprint: r2.locationFingerprint }),
  call('coverageReject', manager, { tenantId: T, requestId: r2.id, expectedFingerprint: r2.locationFingerprint }),
]);
const gano = [c2a, c2b].filter((x) => x.result?.ok === true).length;
const perdio = [c2a, c2b].filter((x) => x.err === 'FAILED_PRECONDITION').length;
const r2b = await requestOf(C2);
check('5. approve+reject concurrentes → exactamente un ganador y un FAILED_PRECONDITION',
  gano === 1 && perdio === 1 && !!r2b.decision && (await jobOf(r2.id))?.action === (r2b.decision.action),
  `ok=${gano} fp=${perdio} decidido=${r2b?.decision?.action}`);

// ===== 6. Nueva dirección ESCRITA durante la revisión: actualiza fingerprint, bot MUDO =====
const C3 = CUST(3);
const r3 = await crearPendiente(C3);
const outsAntes3 = await outsCount(C3);
await postText(C3, 'Mejor: Barrio Herrera calle Molas Lopez 456, porton gris');
await waitFor(async () => (await requestOf(C3))?.locationFingerprint !== r3.locationFingerprint);
const r3b = await requestOf(C3);
check('6. dirección escrita durante coverage_review → MISMO request actualizado (texto) y bot en silencio',
  r3b.id === r3.id && r3b.locationFingerprint !== r3.locationFingerprint && r3b.location?.source === 'text' &&
  r3b.status === 'pending_coverage_review' && (await outsCount(C3)) === outsAntes3,
  `fp ${String(r3.locationFingerprint).slice(0, 10)}→${String(r3b?.locationFingerprint).slice(0, 10)}`);
check('7. la dirección NO queda cruda en el historial: placeholder + dato completo en el request (panel)',
  (await msgsOf(C3)).some((m) => m.text === '📍 Dirección recibida') &&
  !(await msgsOf(C3)).some((m) => (m.text ?? '').includes('Molas Lopez 456')) &&
  String(r3b.location?.addressText ?? '').includes('Molas Lopez 456'));

// ===== 8. Aprobar con el fingerprint VIEJO → failed-precondition; con el nuevo → ok =====
const a3old = await call('coverageApprove', owner, { tenantId: T, requestId: r3.id, expectedFingerprint: r3.locationFingerprint });
const a3new = await call('coverageApprove', owner, { tenantId: T, requestId: r3.id, expectedFingerprint: r3b.locationFingerprint });
check('8. decidir sobre la ubicación VIEJA → FAILED_PRECONDITION; sobre la actual → ok',
  a3old.err === 'FAILED_PRECONDITION' && a3new.result?.ok === true);

// ===== 9. Ubicación NATIVA durante la revisión actualiza el mismo request =====
const C4 = CUST(4);
const r4 = await crearPendiente(C4);
await postLocation(C4, { latitude: LAT + 0.01, longitude: LNG });
await waitFor(async () => (await requestOf(C4))?.locationFingerprint !== r4.locationFingerprint);
const r4b = await requestOf(C4);
check('9. ubicación nativa durante coverage_review → mismo request, fingerprint nuevo (geo)',
  r4b.id === r4.id && String(r4b.locationFingerprint).startsWith('geo:') && r4b.locationFingerprint !== r4.locationFingerprint);

// ===== 10-12. Autorización: seller asignado sí; no asignado no; platform admin no; cross-tenant no =====
const C5 = CUST(5);
const r5 = await crearPendiente(C5, seller1Uid, 'Seller Uno');
check('10. el request queda ASIGNADO al seller del cliente y la campana lo apunta (targetUid)',
  r5.sellerUid === seller1Uid &&
  (await db.collection(`tenants/${T}/notifications`).get()).docs.some((d) => d.data().customerId === C5 && d.data().targetUid === seller1Uid));
const d5no = await call('coverageApprove', seller2, { tenantId: T, requestId: r5.id, expectedFingerprint: r5.locationFingerprint });
const d5admin = await call('coverageApprove', superadmin, { tenantId: T, requestId: r5.id, expectedFingerprint: r5.locationFingerprint });
const d5cross = await call('coverageApprove', owner, { tenantId: 'otro-tenant', requestId: r5.id, expectedFingerprint: r5.locationFingerprint });
const d5si = await call('coverageApprove', seller1, { tenantId: T, requestId: r5.id, expectedFingerprint: r5.locationFingerprint });
check('11. seller NO asignado y PLATFORM_ADMIN → PERMISSION_DENIED; cross-tenant → PERMISSION_DENIED',
  d5no.err === 'PERMISSION_DENIED' && d5admin.err === 'PERMISSION_DENIED' && d5cross.err === 'PERMISSION_DENIED');
check('12. el SELLER ASIGNADO decide su request', d5si.result?.ok === true && (await requestOf(C5)).decision?.byRole === 'SELLER');

// ===== 13. Inexistente y expirado =====
const dNo = await call('coverageApprove', owner, { tenantId: T, requestId: 'covr_zzzzzzzzzzzz', expectedFingerprint: 'geo:x' });
const C6 = CUST(6);
const r6 = await crearPendiente(C6);
await db.doc(`tenants/${T}/coverageRequests/${r6.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
const d6 = await call('coverageApprove', owner, { tenantId: T, requestId: r6.id, expectedFingerprint: r6.locationFingerprint });
check('13. inexistente → NOT_FOUND; expirado → FAILED_PRECONDITION y queda coverage_expired',
  dNo.err === 'NOT_FOUND' && d6.err === 'FAILED_PRECONDITION' && (await requestOf(C6)).status === 'coverage_expired');

// ===== 14. Rechazo con NOTA interna: no viaja al cliente ni a la auditoría =====
const C7 = CUST(7);
const r7 = await crearPendiente(C7);
const outsAntes7 = await outsCount(C7);
const d7 = await call('coverageReject', manager, { tenantId: T, requestId: r7.id, expectedFingerprint: r7.locationFingerprint, note: 'zona sin reparto propio' });
await sleep(1500);
const r7b = await requestOf(C7);
const audits = (await db.collection(`tenants/${T}/auditLogs`).get()).docs.map((d) => JSON.stringify(d.data()));
check('14. rechazo (manager) con nota INTERNA: persiste en el request, jamás al cliente ni a la auditoría',
  d7.result?.ok === true && r7b.decision?.note === 'zona sin reparto propio' && (await outsCount(C7)) === outsAntes7 &&
  (await jobOf(r7.id))?.action === 'rejected' && (await ordersOf(C7)) === 0 &&
  !audits.some((a) => a.includes('zona sin reparto propio')));
check('15. la auditoría no contiene direcciones ni coordenadas',
  !audits.some((a) => a.includes('Molas Lopez') || a.includes(String(LAT))));

// ===== 16. Pedir más información: mensaje determinístico + idempotencia; sin job; sigue pendiente =====
const C8 = CUST(8);
const r8 = await crearPendiente(C8);
const i8 = await call('coverageRequestInfo', owner, { tenantId: T, requestId: r8.id });
await waitFor(async () => ((await lastOut(C8)) ?? '').includes('más de detalle de tu ubicación'), 8000);
const outsTrasInfo = await outsCount(C8);
const i8b = await call('coverageRequestInfo', owner, { tenantId: T, requestId: r8.id });
await sleep(1500);
check('16. requestInfo → mensaje humano determinístico por el mismo canal; doble clic NO re-envía',
  i8.result?.ok === true && i8.result?.already === false && ((await lastOut(C8)) ?? '').includes('ciudad, barrio, calle') &&
  i8b.result?.already === true && (await outsCount(C8)) === outsTrasInfo,
  `already2=${i8b.result?.already}`);
const d17a = (await sessionOf(C8))?.context?.humanTakeover === true;
const d17b = (await requestOf(C8))?.status === 'pending_coverage_review';
const d17c = (await jobOf(r8.id)) === null;
const d17d = (await msgsOf(C8)).some((m) => m.author === 'seller' && (m.text ?? '').includes('más de detalle'));
check('17. requestInfo conserva el takeover y el estado pendiente; sin resume job',
  d17a && d17b && d17c && d17d,
  `takeover=${d17a} pending=${d17b} sinJob=${d17c} msgSeller=${d17d} msgs=${JSON.stringify((await msgsOf(C8)).map((m) => ({ a: m.author, t: (m.text ?? '').slice(0, 30) })))}`);

// ===== 18-20. RULES: coverageRequests + resume jobs + notifications =====
const reqPath = `tenants/${T}/coverageRequests/${r5.id}`;
check('18. rules coverageRequests: owner/manager/seller ASIGNADO/soporte leen; seller ajeno NO; anónimo NO',
  (await restGet(owner, reqPath)) === 200 && (await restGet(manager, reqPath)) === 200 &&
  (await restGet(seller1, reqPath)) === 200 && (await restGet(superadmin, reqPath)) === 200 &&
  (await restGet(seller2, reqPath)) === 403 && (await restGet(null, reqPath)) === 403,
  `o=${await restGet(owner, reqPath)} s2=${await restGet(seller2, reqPath)}`);
check('19. rules: escritura de coverageRequests desde el cliente SIEMPRE rechazada (incluso owner / sellerUid)',
  (await restPatch(owner, reqPath, { sellerUid: { stringValue: seller2Uid } })) === 403 &&
  (await restPatch(seller2, reqPath, { sellerUid: { stringValue: seller2Uid } })) === 403 &&
  (await restGet(owner, `tenants/${T}/coverageResumeJobs/${r1.id}`)) === 403);
const notifC5 = (await db.collection(`tenants/${T}/notifications`).get()).docs.find((d) => d.data().customerId === C5 && d.data().targetUid === seller1Uid);
await db.doc(`tenants/${T}/notifications/trial-test-cr`).set({ id: 'trial-test-cr', tenantId: T, category: 'trial', type: 'trial_ending_soon', title: 't', body: 'b', dedupeKey: 'trial-test-cr', read: false, readAt: null, createdAt: Timestamp.now() });
check('20. rules notifications: seller lee SOLO su aviso handoff; manager lee handoff pero NO trial/billing',
  !!notifC5 &&
  (await restGet(seller1, `tenants/${T}/notifications/${notifC5.id}`)) === 200 &&
  (await restGet(seller2, `tenants/${T}/notifications/${notifC5.id}`)) === 403 &&
  (await restGet(manager, `tenants/${T}/notifications/${notifC5.id}`)) === 200 &&
  (await restGet(manager, `tenants/${T}/notifications/trial-test-cr`)) === 403 &&
  (await restGet(owner, `tenants/${T}/notifications/trial-test-cr`)) === 200);

// ===== 21. La notificación no contiene dirección/coordenadas/teléfono completo =====
const nd = notifC5?.data() ?? {};
check('21. notificación sin dirección, coordenadas ni teléfono completo en título/cuerpo',
  !!notifC5 && !String(nd.title).includes(C5) && !String(nd.body).includes(C5) &&
  String(nd.body).includes(C5.slice(-4)) &&
  !JSON.stringify(nd).includes(String(LAT)) && !JSON.stringify(nd).includes('Molas'));

// ===== 22. LIST reales evaluadas por RULES (la semántica que usa el panel) =====
const qCov = (extra) => ({ from: [{ collectionId: 'coverageRequests' }], where: { compositeFilter: { op: 'AND', filters: [
  { fieldFilter: { field: { fieldPath: 'customerId' }, op: 'EQUAL', value: { stringValue: C5 } } },
  ...extra,
] } } });
const sellerScoped = await restRunQuery(seller1, `tenants/${T}`, qCov([{ fieldFilter: { field: { fieldPath: 'sellerUid' }, op: 'EQUAL', value: { stringValue: seller1Uid } } }]));
const sellerScopedRows = sellerScoped.status === 200 ? (await sellerScoped.json()).filter((r) => r.document).length : 0;
const sellerAncho = await restRunQuery(seller1, `tenants/${T}`, qCov([]));
const managerLista = await restRunQuery(manager, `tenants/${T}`, qCov([]));
check('22. LIST por rules: seller SOLO con query acotada a su uid; sin acotar → denegada; manager sin restricción',
  sellerScoped.status === 200 && sellerScopedRows >= 1 && sellerAncho.status !== 200 && managerLista.status === 200,
  `scoped=${sellerScoped.status}/${sellerScopedRows} ancho=${sellerAncho.status} mgr=${managerLista.status}`);

// ===== 23. requestInfo: rechazos (no asignado / ya decidido) =====
const C10 = CUST(10);
const r10 = await crearPendiente(C10, seller1Uid, 'Seller Uno');
const i10no = await call('coverageRequestInfo', seller2, { tenantId: T, requestId: r10.id });
const i1dec = await call('coverageRequestInfo', owner, { tenantId: T, requestId: r1.id });
check('23. requestInfo: seller NO asignado → PERMISSION_DENIED; request decidido → FAILED_PRECONDITION',
  i10no.err === 'PERMISSION_DENIED' && i1dec.err === 'FAILED_PRECONDITION');

// ===== 24. Rules de UPDATE de notificaciones (read/readAt y nada más) =====
const notifPath = `tenants/${T}/notifications/${notifC5.id}`;
const up = (tok, fields, mask) => restPatch(tok, notifPath, fields, mask);
check('24. update de notifs: seller marca leído SOLO su aviso; manager NO toca avisos dirigidos; owner sí; targetUid inmutable',
  (await up(seller2, { read: { booleanValue: true } }, 'read')) === 403 &&
  (await up(manager, { read: { booleanValue: true } }, 'read')) === 403 &&
  (await up(seller1, { targetUid: { stringValue: 'hack' } }, 'targetUid')) === 403 &&
  (await up(seller1, { read: { booleanValue: true } }, 'read')) === 200 &&
  (await up(owner, { read: { booleanValue: false } }, 'read')) === 200);

// ===== 25. Lector CROSS-TENANT (rules, no callable) =====
await ensureUser('owner@otro-tenant.com', 'TENANT_OWNER');
// claims con OTRO tenant:
{
  const u = await adminAuth.getUserByEmail('owner@otro-tenant.com');
  await adminAuth.setCustomUserClaims(u.uid, { tenantId: 'otro-tenant', role: 'TENANT_OWNER' });
}
const otroOwner = await signIn('owner@otro-tenant.com');
check('25. rules: un owner de OTRO tenant no lee coverageRequests ni notificaciones de este tenant',
  (await restGet(otroOwner, reqPath)) === 403 && (await restGet(otroOwner, notifPath)) === 403);

// ===== 26. Texto-dirección con takeover seller_manual: NO actualiza el request =====
const C11 = CUST(11);
const r11 = await crearPendiente(C11);
await call('chatTakeover', owner, { tenantId: T, customerId: C11 }); // reasigna a seller_manual
await postText(C11, 'Cambio: Avda Espana 999 casi Brasil, porton azul');
await sleep(2500);
const r11b = await requestOf(C11);
check('26. dirección durante takeover MANUAL (no coverage_review) → el request NO cambia',
  r11b.locationFingerprint === r11.locationFingerprint && (await sessionOf(C11))?.context?.handoffReason === 'seller_manual');

} finally {
// ---- Cleanup (SIEMPRE, incluso si un check explota) ----
for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) await call('chatRelease', owner, { tenantId: T, customerId: CUST(i) }).catch(() => {});
await limpiarClientes();
await db.doc(FIX).delete().catch(() => {});
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
await db.doc(`tenants/${T}/notifications/trial-test-cr`).delete().catch(() => {});
await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set(beforeTenant);
if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
{
  const notifs = await db.collection(`tenants/${T}/notifications`).get();
  for (const d of notifs.docs) { if ((d.data().category ?? '') === 'handoff' && String(d.data().customerId ?? '').startsWith('59599410')) await d.ref.delete().catch(() => {}); }
}

}

const ok = results.every(Boolean);
console.log(`\nRESULTADO COVERAGE-1C (revisión humana en el panel): ${ok ? `TODO OK ✅ (${results.length}/${results.length})` : `FALLOS ❌ (${results.filter(Boolean).length}/${results.length})`}`);
process.exit(ok ? 0 : 1);
