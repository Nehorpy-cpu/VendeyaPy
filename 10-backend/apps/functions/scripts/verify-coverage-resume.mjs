/**
 * verify-coverage-resume.mjs — COVERAGE-1D end-to-end (emulador).
 * Consumidor del outbox de reanudación: approved → UNA orden + UNA instrucción (idempotente ante
 * retriggers), rejected → mensaje honesto sin orden/banco, held_by_seller ante takeover ajeno con
 * reactivación al liberar, mensajería con outbox (sent/failed/unknown, sin reenvíos de ACK
 * perdido), expiración + purga de coordenadas por mantenimiento, y feature OFF ⇒ cero proceso.
 *
 * Requiere: emulador (auth+functions+firestore) + seed-users + load-catalog (tenant perfumeria).
 * Es RE-EJECUTABLE sobre el mismo emulador (limpia lo suyo al empezar y al terminar, y restaura
 * la config al salir).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const T = 'perfumeria';
const PNID = '900000000000104';
const FIX = 'aiTestFixtures/ai';
const LAT = -25.31111;
const LNG = -57.61111;
const ACT = 'act-e2e-resume-0001'; // HARDEN-1: activación vigente del flujo en este script

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

let mid = 0;
const wa = (from, messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
  contacts: [{ wa_id: from, profile: { name: 'Cliente RS' } }], messages,
} }] }] });
const postText = (from, body, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.RS-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }])) });
const postLocation = (from, loc, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.RSLOC-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'location', location: loc }])) });
const postImage = (from, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.RSIMG-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'image', image: { id: `MEDIA-${++mid}`, mime_type: 'image/jpeg' } }])) });

const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const outsCount = async (c) => (await msgsOf(c)).filter((m) => m.direction === 'out').length;
const outsCon = async (c, s) => (await msgsOf(c)).filter((m) => m.direction === 'out' && (m.text ?? '').includes(s)).length;
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
/** ADR-0016: los archivos del cliente viven en la raíz del tenant, no bajo el mensaje. */
const adjuntosDe = async (c) => (await db.collection(`tenants/${T}/attachments`).where('customerId', '==', c).get()).docs.map((d) => d.data());
const waitFor = async (pred, maxMs = 20000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(700); } return false; };
const sendAndWait = async (from, text, maxMs = 15000) => { const antes = await outsCount(from); await postText(from, text); const ok = await waitFor(async () => (await outsCount(from)) > antes, maxMs); return ok ? (await msgsOf(from)).filter((m) => m.direction === 'out').pop().text : null; };
const armarCarrito = async (from) => {
  await postText(from, 'hola');
  await waitFor(async () => (await outsCount(from)) > 0);
  await sendAndWait(from, 'agregá la belle');
};
const crearPendiente = async (from) => {
  await armarCarrito(from);
  await sendAndWait(from, 'quiero pagar');
  await postLocation(from, { latitude: LAT, longitude: LNG, address: 'Av. Resume 777, Luque' });
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
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot RS' }, { merge: true });
await db.doc(`tenants/${T}`).set({
  planId: 'starter',
  subscription: { status: 'active', currentPeriodStart: now0 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now0 },
}, { merge: true });
await db.doc(FIX).set({ text: 'Respuesta IA [fixture-rs]' });
const setCoverage = (coverage) => db.doc(`tenants/${T}/config/checkout`).set({
  sellers: [{ name: 'Vendedor RS', whatsapp: '595991000014', active: true }],
  bankAccounts: [{ bank: 'Banco RS', accountNumber: '000-3', holder: 'Titular RS', document: '3333' }],
  ...(coverage !== undefined ? { coverage } : {}),
});
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT });

const superadmin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', superadmin, {
  tenantId: T, wabaId: 'WABA-RS', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 104',
  businessName: 'RS Test', accessToken: 'tok-rs-NUNCA-persistir',
});
if (!rConn.result?.ok) {
  console.error('setup: conexión manual falló', rConn);
  await db.doc(`tenants/${T}`).set(beforeTenant);
  if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
  if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete().catch(() => {});
  if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete().catch(() => {});
  process.exit(1);
}
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });
// ADR-0017 §1: el alta deja `automationMode` AUSENTE a propósito (nacer conectado ≠ nacer
// autorizado). Este merge de UN campo es exactamente lo que hace `migrate-whatsapp-automation-mode.mjs`
// sobre el asset real antes del deploy; sin él el gate por número cierra el inbound como `ignored`.
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ automationMode: 'live' }, { merge: true });
// ADR-0016 §10: la ingesta de adjuntos también nace APAGADA (rollout de dos niveles, fail-closed).
// El caso 6 de acá afirma el contrato de ADR-0016 —el comprobante se PROPONE sobre el pedido sin
// moverlo—, y ese contrato no puede ejercitarse con la ingesta apagada: sin esto el archivo entra
// como `ingest_disabled`, jamás se clasifica y el caso mide otra cosa.
// Son DOS niveles y hacen falta los dos: `ingest.enabled` deja entrar el archivo y `receiptGate`
// es el que lo clasifica como candidato a comprobante. Con solo el primero el adjunto se guarda
// pero nace sin `classification`, que es justo lo que el caso 6 mide.
await db.doc(`tenants/${T}/config/attachments`).set({ ingest: { enabled: true } }, { merge: true });
// `delete` + `set` sin merge, igual que en verify-attachments: un doc heredado de otra corrida
// cambiaría la ventana del gate y el caso mediría un espejismo.
await db.doc(`tenants/${T}/config/receiptGate`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/receiptGate`).set({ enabled: true });
const owner = await signIn('owner@perfumeria.com');

const PREFIJO = '59599420'; // los clientes de este fixture son exclusivos de este script
const CUST = (n) => `${PREFIJO}${String(n).padStart(4, '0')}`;
/**
 * Borra TODO lo que este script escribe para SUS clientes. Se llama AL EMPEZAR y AL TERMINAR.
 *
 * POR QUÉ AL EMPEZAR: sin esto el script solo pasaba en la PRIMERA corrida sobre un emulador
 * recién levantado, porque los checks de "UNA sola" terminaban midiendo historia acumulada:
 *   · los pedidos de la corrida anterior seguían ahí ⇒ `ordersOf` daba 2 donde el contrato exige
 *     exactamente 1 (checks 1, 5, 10, 11…);
 *   · los mensajes viejos hacían que `outsCon(…, 'transferir')` contara las instrucciones de
 *     pago de la corrida anterior además de la de este turno.
 * Mismo molde que `limpiarConversaciones()` de verify-handoff2: conversación completa (mensajes,
 * sesión y ficha) + todo documento tenant-scoped con el customerId del fixture.
 */
const limpiar = async () => {
  for (const ref of (await db.collection(`tenants/${T}/customers`).listDocuments()).filter((r) => r.id.startsWith(PREFIJO))) {
    for (const sub of await ref.listCollections()) for (const d of await sub.listDocuments()) await d.delete().catch(() => {});
    await ref.delete().catch(() => {});
  }
  // ADR-0016: los adjuntos son tenant-scoped; sin esto quedarían archivos del script en el tenant.
  for (const coll of ['orders', 'coverageRequests', 'coverageResumeJobs', 'coverageMessageOutbox', 'notifications', 'attachments']) {
    const snap = await db.collection(`tenants/${T}/${coll}`).get();
    for (const d of snap.docs) { if (String(d.data().customerId ?? '').startsWith(PREFIJO)) await d.ref.delete().catch(() => {}); }
  }
};
await limpiar();

try {

// ===== 1-2. APPROVED: una orden + una instrucción; liberación guardada correcta =====
const C1 = CUST(1);
const r1 = await crearPendiente(C1);
await call('coverageApprove', owner, { tenantId: T, requestId: r1.id, expectedFingerprint: r1.locationFingerprint });
const listo1 = await waitFor(async () => (await jobOf(r1.id))?.status === 'done');
const ses1 = await sessionOf(C1);
const orders1 = await ordersOf(C1);
const job1 = await jobOf(r1.id);
check('1. approved → resume: UNA orden PENDING_PAYMENT + sesión AWAITING_PAYMENT + bot liberado',
  listo1 && orders1.length === 1 && orders1[0].status === 'PENDING_PAYMENT' &&
  ses1?.state === 'AWAITING_PAYMENT' && ses1?.context?.pendingOrderId === orders1[0].id &&
  ses1?.context?.humanTakeover === false && ses1?.context?.coverageResumeInProgress == null,
  `job=${job1?.status} orders=${orders1.length}`);
check('2. UNA sola instrucción de pago, con la intro de cobertura y por el MISMO número',
  (await outsCon(C1, 'transferir')) === 1 && (await outsCon(C1, 'Confirmamos la cobertura')) === 1 &&
  (await msgsOf(C1)).filter((m) => (m.text ?? '').includes('transferir')).every((m) => m.receivedVia === PNID));

// ===== 3. Reservas + referencia de cobertura + dirección textual SIN coordenadas =====
const o1 = orders1[0];
check('3. orderId/checkoutAttemptId reservados en el job; orden referencia la cobertura; dirección TEXTUAL sin coords',
  job1?.orderId === o1.id && !!job1?.checkoutAttemptId && o1.coverage?.requestId === r1.id &&
  o1.delivery?.address?.street === 'Av. Resume 777, Luque' && o1.delivery?.address?.coordinates === null &&
  !JSON.stringify(o1).includes(String(LAT)),
  `attempt=${job1?.checkoutAttemptId?.slice(0, 10)}`);
const ob1 = (await outboxDe(r1.id)).find((m) => m.action === 'approved');
check('4. outbox de mensajería: sent con providerMessageId determinístico del mock',
  ob1?.status === 'sent' && String(ob1?.providerMessageId ?? '').startsWith('mock-'));

// ===== 5. Retrigger del job hecho → CERO duplicados =====
await db.doc(`tenants/${T}/coverageResumeJobs/${r1.id}`).update({ status: 'held_by_seller' });
await db.doc(`tenants/${T}/coverageResumeJobs/${r1.id}`).update({ status: 'pending', updatedAt: Timestamp.now() });
await waitFor(async () => (await jobOf(r1.id))?.status === 'done', 12000);
check('5. retrigger del mismo job → misma orden, sin instrucción duplicada (outbox already_sent)',
  (await ordersOf(C1)).length === 1 && (await outsCon(C1, 'transferir')) === 1 && (await jobOf(r1.id))?.status === 'done');

// ===== 6. Comprobante posterior a la reanudación (contrato ADR-0016) =====
// CAMBIO DE CONTRATO, no relajación: hasta ADR-0016 alcanzaba con que llegara una imagen para que
// el pedido saltara SOLO a PENDING_VERIFICATION y el handoff `payment_verification` sacara al bot
// del chat. Ese era el defecto #1 de la auditoría (una foto de producto congelaba el pedido).
// Ahora recibir un archivo NUNCA mueve un pedido: como la reanudación dejó la sesión en
// AWAITING_PAYMENT con su `pendingOrderId`, el gate lo PROPONE como comprobante del MISMO pedido
// —sugerencia visible— y recién una persona autorizada lo vincula. A PAID no se llega por acá.
await postImage(C1);
const propuesto = await waitFor(async () => (await adjuntosDe(C1)).some((a) => a.classification?.value === 'payment_receipt_candidate'));
const adj1 = (await adjuntosDe(C1)).find((a) => a.classification?.value === 'payment_receipt_candidate') ?? null;
const ord1 = (await ordersOf(C1))[0];
check('6. comprobante tras la reanudación → se PROPONE sobre el pedido correcto SIN moverlo (ADR-0016)',
  propuesto && adj1?.orderCandidateId === o1.id && adj1?.ingestState === 'stored' &&
  ord1?.status === 'PENDING_PAYMENT' && ord1?.payment?.paidAt === null,
  `class=${adj1?.classification?.value} candidato=${adj1?.orderCandidateId === o1.id} pedido=${ord1?.status}`);
const marcado = await call('attachmentMarkAsReceipt', owner, { attachmentId: adj1?.attachmentId, orderId: o1.id });
const ord1b = (await ordersOf(C1))[0];
check('6b. y SOLO la acción humana lo lleva a PENDING_VERIFICATION (jamás a PAID)',
  marcado.result?.ok === true && ord1b?.status === 'PENDING_VERIFICATION' && ord1b?.payment?.paidAt === null,
  `err=${marcado.err} status=${ord1b?.status}`);

// ===== 7. REJECTED: sin orden/banco, mensaje honesto (custom), puntero limpio =====
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT, rejectedMessage: 'No llegamos a esa zona por ahora 🙏 Podés pasarnos otra dirección.' });
const C2 = CUST(2);
const r2 = await crearPendiente(C2);
await call('coverageReject', owner, { tenantId: T, requestId: r2.id, expectedFingerprint: r2.locationFingerprint, note: 'nota secreta interna' });
await waitFor(async () => (await jobOf(r2.id))?.status === 'done');
const ses2 = await sessionOf(C2);
check('7. rejected → cero órdenes/banco; mensaje configurado SIN la nota interna; bot liberado; puntero limpio',
  (await ordersOf(C2)).length === 0 && (await outsCon(C2, 'No llegamos a esa zona')) === 1 &&
  (await outsCon(C2, 'transferir')) === 0 && !(await msgsOf(C2)).some((m) => (m.text ?? '').includes('nota secreta')) &&
  ses2?.context?.humanTakeover === false && ses2?.context?.coverage === null);
const rNueva = await sendAndWait(C2, 'quiero pagar');
check('8. tras el rechazo, "pagar" abre un request NUEVO (la decisión vieja no se reusa)',
  (rNueva ?? '').includes('ciudad') && (await requestOf(C2)).id !== r2.id && (await requestOf(C2)).status === 'awaiting_location');

// ===== 9-10. Takeover AJENO → held_by_seller; la liberación re-encola =====
const C3 = CUST(3);
const r3 = await crearPendiente(C3);
await call('chatTakeover', owner, { tenantId: T, customerId: C3 }); // seller_manual pisa la razón
await call('coverageApprove', owner, { tenantId: T, requestId: r3.id, expectedFingerprint: r3.locationFingerprint });
await waitFor(async () => (await jobOf(r3.id))?.status === 'held_by_seller');
check('9. approve con takeover MANUAL vigente → held_by_seller: sin orden, sin mensaje, takeover intacto',
  (await jobOf(r3.id))?.status === 'held_by_seller' && (await ordersOf(C3)).length === 0 &&
  (await outsCon(C3, 'transferir')) === 0 && (await sessionOf(C3))?.context?.handoffReason === 'seller_manual');
await call('chatRelease', owner, { tenantId: T, customerId: C3 });
const listo3 = await waitFor(async () => (await jobOf(r3.id))?.status === 'done');
check('10. la liberación manual re-encola el job → orden única + instrucción única',
  listo3 && (await ordersOf(C3)).length === 1 && (await outsCon(C3, 'transferir')) === 1 &&
  (await sessionOf(C3))?.state === 'AWAITING_PAYMENT');

// ===== 11. Carrito CAMBIADO (misma ubicación aprobada) → sin re-review, orden del carrito actual =====
const C4 = CUST(4);
const r4 = await crearPendiente(C4);
// el carrito cambia mientras está en revisión (admin simula: cantidad x3)
const ses4 = await sessionOf(C4);
const item4 = ses4.cart.items[0];
await db.doc(`tenants/${T}/customers/${C4}/sessions/active`).update({
  'cart.items': [{ ...item4, quantity: 3 }],
  'cart.subtotal': item4.price * 3,
});
await call('coverageApprove', owner, { tenantId: T, requestId: r4.id, expectedFingerprint: r4.locationFingerprint });
await waitFor(async () => (await jobOf(r4.id))?.status === 'done');
const o4 = (await ordersOf(C4))[0];
check('11. carrito cambiado + misma ubicación aprobada → SIN nueva revisión; la orden usa el carrito ACTUAL',
  o4?.items?.[0]?.quantity === 3 && o4?.totals?.total === item4.price * 3 && (await ordersOf(C4)).length === 1);

// ===== 12. Carrito VACÍO → sin orden; cobertura sigue vigente =====
const C5 = CUST(5);
const r5 = await crearPendiente(C5);
await db.doc(`tenants/${T}/customers/${C5}/sessions/active`).update({ 'cart.items': [], 'cart.subtotal': 0 });
await call('coverageApprove', owner, { tenantId: T, requestId: r5.id, expectedFingerprint: r5.locationFingerprint });
await waitFor(async () => (await jobOf(r5.id))?.status === 'done');
check('12. carrito vacío → sin orden; aviso honesto; liberado; aprobación VIGENTE',
  (await ordersOf(C5)).length === 0 && (await outsCon(C5, 'carrito quedó vacío')) === 1 &&
  (await sessionOf(C5))?.context?.humanTakeover === false && (await requestOf(C5)).status === 'coverage_approved');

// ===== 13. send FAILED → orden queda; retry controlado la completa =====
const C6 = CUST(6);
const r6 = await crearPendiente(C6);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failSendText: 'error' });
await call('coverageApprove', owner, { tenantId: T, requestId: r6.id, expectedFingerprint: r6.locationFingerprint });
await waitFor(async () => (await jobOf(r6.id))?.status === 'send_failed');
const antes6 = await outsCon(C6, 'transferir');
check('13. fallo CONFIRMADO del envío → job send_failed, orden creada, cero mensaje',
  (await jobOf(r6.id))?.status === 'send_failed' && (await ordersOf(C6)).length === 1 && antes6 === 0);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();
await db.doc(`tenants/${T}/coverageResumeJobs/${r6.id}`).update({ status: 'pending', updatedAt: Timestamp.now() });
await waitFor(async () => (await jobOf(r6.id))?.status === 'done');
check('14. retry controlado tras el fallo → MISMA orden y UNA instrucción',
  (await ordersOf(C6)).length === 1 && (await outsCon(C6, 'transferir')) === 1);

// ===== 15. send UNKNOWN (timeout) → JAMÁS reenvío automático =====
const C7 = CUST(7);
const r7 = await crearPendiente(C7);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failSendText: 'timeout' });
await call('coverageApprove', owner, { tenantId: T, requestId: r7.id, expectedFingerprint: r7.locationFingerprint });
await waitFor(async () => (await jobOf(r7.id))?.status === 'send_unknown');
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();
await db.doc(`tenants/${T}/coverageResumeJobs/${r7.id}`).update({ status: 'pending', updatedAt: Timestamp.now() });
await sleep(4000);
check('15. ACK perdido (timeout) → send_unknown; el retrigger NO reenvía instrucciones bancarias',
  (await jobOf(r7.id))?.status === 'send_unknown' && (await outsCon(C7, 'transferir')) === 0 &&
  (await outboxDe(r7.id)).find((m) => m.action === 'approved')?.status === 'unknown' &&
  (await ordersOf(C7)).length === 1);

// ===== 16. Cliente escribe DURANTE el resume (marca en curso) — simulado =====
const C8 = CUST(8);
const r8 = await crearPendiente(C8);
// Simulación determinística: la marca puesta y un "pagar" concurrente (sin decidir todavía).
await db.doc(`tenants/${T}/customers/${C8}/sessions/active`).update({
  'context.humanTakeover': false, 'context.handoffReason': null, 'context.handoffSourceId': null,
  'context.coverageResumeInProgress': r8.id,
});
const rDurante = await sendAndWait(C8, 'quiero pagar');
check('16. "pagar" con reanudación EN CURSO → "estamos preparando tu pedido", sin otra orden, y la MARCA sobrevive el turno',
  (rDurante ?? '').includes('preparando tu pedido') && (await ordersOf(C8)).length === 0 &&
  (await sessionOf(C8))?.context?.coverageResumeInProgress === r8.id);
await db.doc(`tenants/${T}/customers/${C8}/sessions/active`).update({ 'context.coverageResumeInProgress': null });

// ===== 17-18. EXPIRACIÓN por mantenimiento + PURGA de coordenadas =====
const C9 = CUST(9);
const r9 = await crearPendiente(C9);
await db.doc(`tenants/${T}/coverageRequests/${r9.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
const rMant = await fetch(`${BASE}/devRunCoverageMaintenance`);
await waitFor(async () => (await requestOf(C9))?.status === 'coverage_expired');
const r9b = await requestOf(C9);
check('17. mantenimiento: request vencido → coverage_expired + liberado + mensaje honesto + purga agendada',
  rMant.status === 200 && r9b?.status === 'coverage_expired' && r9b?.coordinatesPurgeAt != null &&
  (await sessionOf(C9))?.context?.humanTakeover === false && (await outsCon(C9, 'venció')) === 1 &&
  (await ordersOf(C9)).length === 0);
await db.doc(`tenants/${T}/coverageRequests/${r9.id}`).update({ coordinatesPurgeAt: Timestamp.fromMillis(Date.now() - 1000) });
await fetch(`${BASE}/devRunCoverageMaintenance`);
await waitFor(async () => (await requestOf(C9))?.location?.coordinates == null);
const r9c = await requestOf(C9);
check('18. purga: coordenadas y nombre eliminados; dirección textual, decisión y fingerprint conservados',
  r9c?.location?.coordinates == null && r9c?.location?.name == null &&
  r9c?.location?.addressText === 'Av. Resume 777, Luque' && r9c?.locationFingerprint === r9.locationFingerprint &&
  r9c?.coordinatesPurgeAt == null);

// ===== 19. Feature OFF → cero procesamiento =====
const C10 = CUST(10);
const r10 = await crearPendiente(C10);
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT }); // sin rejectedMessage custom
await call('coverageApprove', owner, { tenantId: T, requestId: r10.id, expectedFingerprint: r10.locationFingerprint });
await waitFor(async () => (await jobOf(r10.id))?.status === 'done');
await setCoverage({ enabled: false });
const C11 = CUST(11);
// flag off: el gate no corre — armamos el job a mano simulando una decisión previa válida
// (enfoque: request aprobado + job pending, y el consumidor debe NEGARSE a procesar)
const r11fake = { ...r10, id: 'covr_flagoffTest1', customerId: C11, status: 'coverage_approved' };
await db.doc(`tenants/${T}/coverageRequests/covr_flagoffTest1`).set({ ...r11fake, decision: (await requestOf(C10)).decision });
await db.doc(`tenants/${T}/coverageResumeJobs/covr_flagoffTest1`).set({
  id: 'covr_flagoffTest1', tenantId: T, coverageRequestId: 'covr_flagoffTest1', customerId: C11,
  action: 'approved', status: 'pending', channel: 'whatsapp', receivedVia: PNID, activationId: ACT,
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
});
await sleep(4000);
check('19. feature OFF → el consumidor NO procesa (job queda pending, cero órdenes/mensajes)',
  (await jobOf('covr_flagoffTest1'))?.status === 'pending' && (await ordersOf(C11)).length === 0 && (await outsCount(C11)) === 0);
// borrar el job fake ANTES de re-encender (un trigger demorado no debe procesarlo con el flag on)
await db.doc(`tenants/${T}/coverageResumeJobs/covr_flagoffTest1`).delete().catch(() => {});
await db.doc(`tenants/${T}/coverageRequests/covr_flagoffTest1`).delete().catch(() => {});

// ===== 19b. HARDEN-1: job de una activación ANTERIOR + activación NUEVA → cancelado sin efectos =====
await setCoverage({ enabled: true, expiryHours: 24, activationId: 'act-e2e-resume-0002' });
const C12 = CUST(12);
// La sesión arranca con la marca anti-doble-checkout puesta (como si un worker viejo hubiera
// crasheado post-claim): la cancelación stale DEBE limpiarla en la MISMA transacción del claim.
await db.doc(`tenants/${T}/customers/${C12}/sessions/active`).set({
  id: 'active', tenantId: T, customerId: C12, state: 'CART', cart: { items: [], subtotal: 0 },
  context: { coverageResumeInProgress: 'covr_staleActTest1' }, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
});
const r12fake = { ...r10, id: 'covr_staleActTest1', customerId: C12, status: 'coverage_approved', activationId: ACT };
await db.doc(`tenants/${T}/coverageRequests/covr_staleActTest1`).set({ ...r12fake, decision: (await requestOf(C10)).decision, resume: { status: 'pending', orderId: null } });
await db.doc(`tenants/${T}/coverageResumeJobs/covr_staleActTest1`).set({
  id: 'covr_staleActTest1', tenantId: T, coverageRequestId: 'covr_staleActTest1', customerId: C12,
  action: 'approved', status: 'pending', channel: 'whatsapp', receivedVia: PNID, activationId: ACT,
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
});
await waitFor(async () => (await jobOf('covr_staleActTest1'))?.status === 'cancelled', 12000);
const rStale = (await db.doc(`tenants/${T}/coverageRequests/covr_staleActTest1`).get()).data() ?? {};
check('19b. job de activación ANTERIOR con el flag re-encendido (id nuevo) → cancelled: cero orden/mensaje/banco/liberación',
  (await jobOf('covr_staleActTest1'))?.status === 'cancelled' && rStale.resume?.status === 'cancelled' &&
  rStale.status === 'coverage_approved' && rStale.decision?.action === 'approved' && // la DECISIÓN histórica no se toca
  (await ordersOf(C12)).length === 0 && (await outsCount(C12)) === 0,
  `job=${(await jobOf('covr_staleActTest1'))?.status} resume=${rStale.resume?.status}`);
const notifStale = (await db.collection(`tenants/${T}/notifications`).get()).docs
  .map((d) => d.data()).find((n) => n.type === 'handoff_coverage_stale' && n.customerId === C12);
check('19b2. la cancelación limpió la marca anti-doble-checkout EN el claim y avisó al equipo por la campana (sin PII)',
  ((await sessionOf(C12))?.context?.coverageResumeInProgress ?? null) === null &&
  !!notifStale && !JSON.stringify(notifStale).includes('Resume 777') &&
  !String(notifStale?.title ?? '').includes(C12) && String(notifStale?.body ?? '').includes(C12.slice(-4)),
  `marca=${(await sessionOf(C12))?.context?.coverageResumeInProgress} notif=${notifStale?.type}`);
await db.doc(`tenants/${T}/coverageRequests/covr_staleActTest1`).delete().catch(() => {});
await db.doc(`tenants/${T}/coverageResumeJobs/covr_staleActTest1`).delete().catch(() => {});

// ===== 19b3. HARDEN-1 (review): `processing` HUÉRFANO de una activación anterior → el
// mantenimiento lo RE-ENCOLA y el claim lo cancela limpiando la marca (saltearlo lo dejaba
// congelado para siempre con el cliente clavado en "estamos preparando tu pedido") =====
const rP = { ...r10, id: 'covr_staleProcTest1', customerId: C12, status: 'coverage_approved', activationId: ACT };
await db.doc(`tenants/${T}/coverageRequests/covr_staleProcTest1`).set({ ...rP, decision: (await requestOf(C10)).decision, resume: { status: 'processing', orderId: null } });
await db.doc(`tenants/${T}/customers/${C12}/sessions/active`).update({ 'context.coverageResumeInProgress': 'covr_staleProcTest1' });
await db.doc(`tenants/${T}/coverageResumeJobs/covr_staleProcTest1`).set({
  id: 'covr_staleProcTest1', tenantId: T, coverageRequestId: 'covr_staleProcTest1', customerId: C12,
  action: 'approved', status: 'processing', channel: 'whatsapp', receivedVia: PNID, activationId: ACT,
  leaseUntil: Timestamp.fromMillis(Date.now() - 5000), attempts: 1,
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
});
await fetch(`${BASE}/devRunCoverageMaintenance`);
await waitFor(async () => (await jobOf('covr_staleProcTest1'))?.status === 'cancelled', 15000);
check('19b3. processing huérfano de activación anterior → mantenimiento re-encola → cancelled + marca limpia, cero efectos',
  (await jobOf('covr_staleProcTest1'))?.status === 'cancelled' &&
  ((await sessionOf(C12))?.context?.coverageResumeInProgress ?? null) === null &&
  (await ordersOf(C12)).length === 0 && (await outsCount(C12)) === 0,
  `job=${(await jobOf('covr_staleProcTest1'))?.status}`);
await db.doc(`tenants/${T}/coverageRequests/covr_staleProcTest1`).delete().catch(() => {});
await db.doc(`tenants/${T}/coverageResumeJobs/covr_staleProcTest1`).delete().catch(() => {});

// ===== 19c-19e. chatRelease gated + mantenimiento con flag OFF =====
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT });
const C13 = CUST(13);
const r13 = await crearPendiente(C13);
await call('chatTakeover', owner, { tenantId: T, customerId: C13 }); // seller_manual pisa la razón
await call('coverageApprove', owner, { tenantId: T, requestId: r13.id, expectedFingerprint: r13.locationFingerprint });
await waitFor(async () => (await jobOf(r13.id))?.status === 'held_by_seller');

// 19c: flag OFF → la liberación manual NO re-encola el job retenido.
await setCoverage({ enabled: false });
await call('chatRelease', owner, { tenantId: T, customerId: C13 });
await sleep(3500);
check('19c. chatRelease con flag OFF → el job held_by_seller NO se re-encola (queda inerte, sin orden/mensaje)',
  (await jobOf(r13.id))?.status === 'held_by_seller' && (await ordersOf(C13)).length === 0 && (await outsCon(C13, 'transferir')) === 0);

// 19d: activación NUEVA (job stale) → tampoco se re-encola, ni por release ni por mantenimiento.
await setCoverage({ enabled: true, expiryHours: 24, activationId: 'act-e2e-resume-0003' });
await call('chatTakeover', owner, { tenantId: T, customerId: C13 });
await call('chatRelease', owner, { tenantId: T, customerId: C13 });
await fetch(`${BASE}/devRunCoverageMaintenance`);
await sleep(3500);
check('19d. chatRelease + mantenimiento con activación NUEVA → el job de la activación anterior sigue held (inerte)',
  (await jobOf(r13.id))?.status === 'held_by_seller' && (await ordersOf(C13)).length === 0 && (await outsCon(C13, 'transferir')) === 0);

// 19d2: request pendiente de activación ANTERIOR con flag ON y SIN takeover → el mantenimiento
// expira (higiene) pero NO manda el mensaje de vencimiento (solo 'liberado_vigente' avisa).
const C11b = CUST(11);
const r11b = await crearPendiente(C11b); // bajo act-e2e-resume-0003 (activo desde 19d)
await call('chatRelease', owner, { tenantId: T, customerId: C11b }); // sin takeover
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT }); // rota: r11b queda stale
await db.doc(`tenants/${T}/coverageRequests/${r11b.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
await fetch(`${BASE}/devRunCoverageMaintenance`);
await waitFor(async () => (await requestOf(C11b))?.status === 'coverage_expired');
check('19d2. vencido de activación ANTERIOR con flag ON (sin takeover) → expira sin mensaje de vencimiento',
  (await requestOf(C11b))?.status === 'coverage_expired' && (await outsCon(C11b, 'venció')) === 0 &&
  ((await sessionOf(C11b))?.context?.coverage ?? null) === null,
  `status=${(await requestOf(C11b))?.status} vencioMsgs=${await outsCon(C11b, 'venció')}`);

// 19e: mantenimiento con flag OFF → expira (higiene) SIN liberar takeover ni mensaje; la purga corre igual.
const C14 = CUST(14);
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT });
const r14 = await crearPendiente(C14); // deja takeover coverage_review vigente
await setCoverage({ enabled: false });
await db.doc(`tenants/${T}/coverageRequests/${r14.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
await fetch(`${BASE}/devRunCoverageMaintenance`);
await waitFor(async () => (await requestOf(C14))?.status === 'coverage_expired');
const r14b = await requestOf(C14);
const ses14 = await sessionOf(C14);
check('19e. mantenimiento con flag OFF → coverage_expired + purga agendada, PERO sin liberar el takeover ni mensaje',
  r14b?.status === 'coverage_expired' && r14b?.coordinatesPurgeAt != null &&
  ses14?.context?.humanTakeover === true && ses14?.context?.handoffReason === 'coverage_review' &&
  (await outsCon(C14, 'venció')) === 0 && (await ordersOf(C14)).length === 0,
  `status=${r14b?.status} takeover=${ses14?.context?.humanTakeover}`);
await db.doc(`tenants/${T}/coverageRequests/${r14.id}`).update({ coordinatesPurgeAt: Timestamp.fromMillis(Date.now() - 1000) });
await fetch(`${BASE}/devRunCoverageMaintenance`);
await waitFor(async () => (await requestOf(C14))?.location?.coordinates == null);
check('19f. la PURGA de privacidad corre igual con flag OFF (coordenadas y nombre eliminados)',
  (await requestOf(C14))?.location?.coordinates == null && (await requestOf(C14))?.location?.name == null);
await setCoverage({ enabled: true, expiryHours: 24, activationId: ACT });

// ===== 20. Rules: outbox de mensajería backend-only; multi-tenant =====
const obDoc = (await db.collection(`tenants/${T}/coverageMessageOutbox`).limit(1).get()).docs[0];
check('20. rules: coverageMessageOutbox invisible incluso para el owner; jobs con tenantId correcto',
  !!obDoc && (await restGet(owner, `tenants/${T}/coverageMessageOutbox/${obDoc.id}`)) === 403 &&
  (await db.collection(`tenants/${T}/coverageResumeJobs`).get()).docs.every((d) => d.data().tenantId === T));

} finally {
  await db.doc(`tenants/${T}/coverageRequests/covr_flagoffTest1`).delete().catch(() => {});
  await db.doc(`tenants/${T}/coverageResumeJobs/covr_flagoffTest1`).delete().catch(() => {});
  await db.doc(`tenants/${T}/coverageRequests/covr_staleActTest1`).delete().catch(() => {});
  await db.doc(`tenants/${T}/coverageResumeJobs/covr_staleActTest1`).delete().catch(() => {});
  await db.doc(`tenants/${T}/coverageRequests/covr_staleProcTest1`).delete().catch(() => {});
  await db.doc(`tenants/${T}/coverageResumeJobs/covr_staleProcTest1`).delete().catch(() => {});
  await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete().catch(() => {});
  await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
  for (let i = 1; i <= 14; i++) await call('chatRelease', owner, { tenantId: T, customerId: CUST(i) }).catch(() => {});
  await limpiar();
  await db.doc(FIX).delete().catch(() => {});
  await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
  await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
  await db.doc(`tenants/${T}`).set(beforeTenant);
  if (beforeChannels) await db.doc(`tenants/${T}/config/channels`).set(beforeChannels); else await db.doc(`tenants/${T}/config/channels`).delete();
  if (beforeAgent) await db.doc(`tenants/${T}/config/agent`).set(beforeAgent); else await db.doc(`tenants/${T}/config/agent`).delete();
  if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete();
}

const ok = results.every(Boolean);
console.log(`\nRESULTADO COVERAGE-1D (reanudación del checkout): ${ok ? `TODO OK ✅ (${results.length}/${results.length})` : `FALLOS ❌ (${results.filter(Boolean).length}/${results.length})`}`);
process.exit(ok ? 0 : 1);
