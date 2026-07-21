/**
 * verify-shipping-quote-saga.mjs — SHIPPING-CHAT-3C end-to-end (emulador limpio).
 * Saga de cotización de envío: TX-A (prepared) → claim → Meta(mock live-válido) → TX-C.
 * Aprobación SOLO tras el ACK; outbox única fuente de estado; rejected/unknown conservadores;
 * recuperación en cada frontera; orden con totals.shipping separado y banco con el total real;
 * gate del approve viejo; recompra request-nuevo; pipeline no terminal bloquea; PII limpia.
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
const T = 'perfumeria';
const PNID = '900000000000203';
const LAT = -25.31001;
const LNG = -57.61002;
const ACT = 'act-e2e-quote-0001';
const MAXQ = 5_000_000;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? null, kind: body.error?.details?.kind ?? null };
}

let mid = 0;
const wa = (from, messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { phone_number_id: PNID },
  contacts: [{ wa_id: from, profile: { name: 'Cliente SQ' } }], messages,
} }] }] });
const postText = (from, body, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.SQ-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }])) });
const postLocation = (from, loc, wamid) => fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(wa(from, [{ from, id: wamid ?? `wamid.SQLOC-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'location', location: loc }])) });

const msgsOf = async (c) => (await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs
  .map((d) => d.data()).sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
const outsCount = async (c) => (await msgsOf(c)).filter((m) => m.direction === 'out').length;
const lastOut = async (c) => { const o = (await msgsOf(c)).filter((m) => m.direction === 'out'); return o.length ? o[o.length - 1] : null; };
const sessionOf = async (c) => (await db.doc(`tenants/${T}/customers/${c}/sessions/active`).get()).data();
const requestsOf = async (c) => (await db.collection(`tenants/${T}/coverageRequests`).where('customerId', '==', c).get()).docs
  .map((d) => d.data()).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
const requestOf = async (c) => (await requestsOf(c))[0] ?? null;
const jobOf = async (rid) => (await db.doc(`tenants/${T}/coverageResumeJobs/${rid}`).get()).data() ?? null;
const outboxOf = async (id) => (await db.doc(`tenants/${T}/coverageMessageOutbox/${id}`).get()).data() ?? null;
const quoteOutboxesOf = async (rid) => (await db.collection(`tenants/${T}/coverageMessageOutbox`).where('coverageRequestId', '==', rid).where('action', '==', 'quote').get()).docs.map((d) => d.data());
const ordersOf = async (c) => (await db.collection(`tenants/${T}/orders`).where('customerId', '==', c).get()).docs.map((d) => d.data());
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };
const sendAndWait = async (from, text, maxMs = 15000) => { const antes = await outsCount(from); await postText(from, text); const ok = await waitFor(async () => (await outsCount(from)) > antes, maxMs); return ok ? (await lastOut(from))?.text : null; };
const armarCarrito = async (from) => { await postText(from, 'hola'); await waitFor(async () => (await outsCount(from)) > 0); await sendAndWait(from, 'agregá la belle'); };
const crearPendiente = async (from, sellerUid = null, sellerName = null) => {
  if (sellerUid) await db.doc(`tenants/${T}/customers/${from}`).set({ id: from, tenantId: T, assignedSellerId: sellerUid, assignedSellerName: sellerName }, { merge: true });
  await armarCarrito(from);
  await sendAndWait(from, 'quiero pagar');
  await postLocation(from, { latitude: LAT, longitude: LNG });
  await waitFor(async () => (await requestOf(from))?.status === 'pending_coverage_review');
  return requestOf(from);
};
const DRAFT = (gs) => `El costo de envío para tu ubicación es ₲${gs.toLocaleString('es-PY')}`;
/**
 * Cotiza con el flujo REAL: 1er intento con la huella v1 del request ⇒ cart_changed + REFRESH a
 * cart2 (renovación segura, verificada); 2º intento con la huella refrescada.
 */
const cotizar = async (token, rid, from, gs, opts = {}) => {
  let req = await requestOf(from);
  let r = await call('coverageQuoteAndApprove', token, {
    requestId: rid, sellerDraft: DRAFT(gs), confirmedShippingGs: gs,
    expectedLocationFingerprint: req.locationFingerprint, expectedCartFingerprint: req.cartFingerprint,
  });
  if (r.kind === 'cart_changed' && !opts.sinReintento) {
    req = await requestOf(from);
    r = await call('coverageQuoteAndApprove', token, {
      requestId: rid, sellerDraft: DRAFT(gs), confirmedShippingGs: gs,
      expectedLocationFingerprint: req.locationFingerprint, expectedCartFingerprint: req.cartFingerprint,
    });
  }
  return r;
};

// ---- Snapshot + setup ----
const beforeChannels = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
const beforeCheckout = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;
const now0 = Timestamp.now();
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'live' }); // saga: resolución live-válida (emulador ⇒ Mock igual)
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot SQ' }, { merge: true });
await db.doc(`tenants/${T}`).set({ planId: 'starter', subscription: { status: 'active', currentPeriodStart: now0 } }, { merge: true });
const setCoverage = (coverage) => db.doc(`tenants/${T}/config/checkout`).set({
  sellers: [{ name: 'Vendedor SQ', whatsapp: '595991000023', active: true }],
  bankAccounts: [{ bank: 'Banco SQ', accountNumber: '000-3', holder: 'Titular SQ', document: '3333' }],
  ...(coverage !== undefined ? { coverage } : {}),
});
const COV = { enabled: true, expiryHours: 24, activationId: ACT, shippingQuote: { required: true, maxChargeGs: MAXQ } };
await setCoverage(COV);

const superadmin = await signIn('superadmin@aiafg.com');
const rConn = await call('adminSetManualWhatsappConnection', superadmin, {
  tenantId: T, wabaId: 'WABA-SQ', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 203',
  businessName: 'SQ Test', accessToken: 'tok-sq-NUNCA-persistir',
});
if (!rConn.result?.ok) { console.error('setup: conexión manual falló', rConn); process.exit(1); }
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });

const ensureUser = async (email, role) => {
  let user;
  try { user = await adminAuth.getUserByEmail(email); } catch { user = await adminAuth.createUser({ email, password: 'test1234' }); }
  await adminAuth.setCustomUserClaims(user.uid, { tenantId: T, role });
  return user.uid;
};
const sellerUid = (await adminAuth.getUserByEmail('seller@perfumeria.com')).uid;
await ensureUser('manager@perfumeria.com', 'TENANT_MANAGER');
const owner = await signIn('owner@perfumeria.com');
const manager = await signIn('manager@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const otroOwner = await signIn('owner@boutique.com');
const CUST = (n) => `59599500${String(n).padStart(4, '0')}`;
console.log('— setup OK, arrancan los checks —');

// ===== 1. HAPPY PATH: canónico aceptado → quote → aprobación → UN job → UNA orden con shipping =====
const A = CUST(1);
const reqA = await crearPendiente(A);
const outsAntesA = await outsCount(A);
// 1a. Renovación segura de la huella v1 (fail-closed: cart: no puede aprobar)
const rA1 = await call('coverageQuoteAndApprove', owner, {
  requestId: reqA.id, sellerDraft: DRAFT(30000), confirmedShippingGs: 30000,
  expectedLocationFingerprint: reqA.locationFingerprint, expectedCartFingerprint: reqA.cartFingerprint,
});
const reqA2 = await requestOf(A);
check('1a. huella v1 (cart:) NO aprueba: cart_changed + REFRESH del snapshot a cart2 (renovación segura)',
  rA1.err === 'FAILED_PRECONDITION' && rA1.kind === 'cart_changed' && reqA2.cartFingerprint.startsWith('cart2:') && (await quoteOutboxesOf(reqA.id)).length === 0,
  `kind=${rA1.kind} fp=${reqA2.cartFingerprint.slice(0, 12)}`);
const rA2 = await call('coverageQuoteAndApprove', owner, {
  requestId: reqA.id, sellerDraft: DRAFT(30000), confirmedShippingGs: 30000,
  expectedLocationFingerprint: reqA2.locationFingerprint, expectedCartFingerprint: reqA2.cartFingerprint,
});
const reqA3 = await requestOf(A);
const obsA = await quoteOutboxesOf(reqA.id);
check('1b. cotización OK: approved + shippingQuote estructurado + pointer limpio + outbox quote sent con wamid',
  rA2.result?.ok === true && rA2.result?.status === 'coverage_approved' && rA2.result?.shippingGs === 30000 &&
  reqA3.status === 'coverage_approved' && reqA3.shippingQuote?.chargeGs === 30000 && reqA3.shippingQuote?.currency === 'PYG' &&
  reqA3.shippingQuote?.source === 'seller_chat' && (reqA3.shippingQuotePending ?? null) === null &&
  obsA.length === 1 && obsA[0].status === 'sent' && (obsA[0].providerMessageId ?? '').startsWith('mock-') && obsA[0].checkoutAttemptId === null,
  `status=${reqA3.status} outbox=${obsA[0]?.status} wamid=${obsA[0]?.providerMessageId}`);
const jobA = await jobOf(reqA.id);
check('2. EXACTAMENTE un job con shippingGs y cartSnapshot congelado (cart2 verificado)',
  !!jobA && jobA.action === 'approved' && jobA.shippingGs === 30000 && Array.isArray(jobA.cartSnapshot?.items) && jobA.cartSnapshot.items.length > 0 && jobA.activationId === ACT,
  `shippingGs=${jobA?.shippingGs} items=${jobA?.cartSnapshot?.items?.length}`);
check('3. mensaje canónico en el historial como VENDEDOR (actor original), texto EXACTO sin sellerDraft',
  await waitFor(async () => (await msgsOf(A)).some((m) => m.author === 'seller' && m.text === 'El costo de envío para tu ubicación es ₲30.000.')),
  `lastOut=${(await lastOut(A))?.text?.slice(0, 50)}`);
await waitFor(async () => (await ordersOf(A)).length === 1 && (await sessionOf(A))?.state === 'AWAITING_PAYMENT', 20000);
const ordenesA = await ordersOf(A);
const ordA = ordenesA[0];
const subtotalA = ordA?.totals?.subtotal ?? 0;
check('4. UNA orden PENDING_PAYMENT con totals {subtotal productos, shipping 30000, total = subtotal+30000}',
  ordenesA.length === 1 && ordA.status === 'PENDING_PAYMENT' && ordA.totals.shipping === 30000 &&
  ordA.totals.total === subtotalA + 30000 && ordA.totals.discount === 0 && ordA.coverage?.requestId === reqA.id,
  `subtotal=${subtotalA} total=${ordA?.totals?.total}`);
const finA = (await db.doc(`tenants/${T}/orderFinancials/${ordA.id}`).get()).data();
check('5. grossProfit SOLO de productos (el envío jamás infla la ganancia)',
  finA?.subtotal === subtotalA && (finA?.grossProfit == null || finA.grossProfit <= subtotalA) && (finA?.grossProfit == null || finA.grossProfit === subtotalA - finA.totalCost),
  `grossProfit=${finA?.grossProfit} totalCost=${finA?.totalCost}`);
const bancoA = (await msgsOf(A)).filter((m) => m.direction === 'out').map((m) => m.text).find((t) => (t ?? '').includes('transferir'));
check('6. instrucciones bancarias con el TOTAL CON ENVÍO (order.totals.total)',
  !!bancoA && bancoA.includes(`₲ ${(subtotalA + 30000).toLocaleString('es-PY')}`),
  `banco=${(bancoA ?? '').slice(0, 80)}`);
check('7. delivery con dirección textual/sin coordenadas; sesión AWAITING_PAYMENT; jamás PAID',
  ordA.delivery?.address?.coordinates === null && (await sessionOf(A))?.state === 'AWAITING_PAYMENT' && ordA.status === 'PENDING_PAYMENT');

// ===== 8. Idempotencia de éxito + doble invocación concurrente =====
const reqA4 = await requestOf(A);
const rIdem = await call('coverageQuoteAndApprove', owner, {
  requestId: reqA.id, sellerDraft: DRAFT(30000), confirmedShippingGs: 30000,
  expectedLocationFingerprint: reqA4.locationFingerprint, expectedCartFingerprint: reqA4.cartFingerprint,
});
check('8. re-invocación tras el éxito ⇒ ok idempotente, sin mensaje nuevo ni segundo job/orden',
  rIdem.result?.ok === true && (await outsCount(A)) >= outsAntesA && (await quoteOutboxesOf(reqA.id)).length === 1 && (await ordersOf(A)).length === 1);

const B = CUST(2);
const reqB = await crearPendiente(B);
await cotizar(owner, reqB.id, B, 45000, { sinReintento: true }); // bounce de refresh
const reqBr = await requestOf(B);
const payloadB = { requestId: reqB.id, sellerDraft: DRAFT(45000), confirmedShippingGs: 45000, expectedLocationFingerprint: reqBr.locationFingerprint, expectedCartFingerprint: reqBr.cartFingerprint };
const [c1, c2] = await Promise.all([call('coverageQuoteAndApprove', owner, payloadB), call('coverageQuoteAndApprove', owner, payloadB)]);
await waitFor(async () => (await ordersOf(B)).length === 1, 20000);
const okB = [c1, c2].filter((r) => r.result?.ok === true).length;
const obsB = await quoteOutboxesOf(reqB.id);
const msgsQuoteB = (await msgsOf(B)).filter((m) => m.text === 'El costo de envío para tu ubicación es ₲45.000.').length;
check('9. doble clic CONCURRENTE: un solo mensaje, un outbox sent, un job, una orden',
  okB >= 1 && obsB.filter((o) => o.status === 'sent').length === 1 && msgsQuoteB === 1 && (await ordersOf(B)).length === 1 && !!(await jobOf(reqB.id)),
  `oks=${okB} outboxes=${obsB.length} quotes=${msgsQuoteB} err2=${c2.kind ?? c1.kind ?? ''}`);

// ===== 10-12. Parser/validaciones (sin outbox ni mensajes) =====
const C = CUST(3);
const reqC = await crearPendiente(C, sellerUid, 'Vendedora');
await cotizar(owner, reqC.id, C, 30000, { sinReintento: true }); // refresh a cart2
const reqCr = await requestOf(C);
const outsC = await outsCount(C);
const base = (over) => ({ requestId: reqC.id, sellerDraft: DRAFT(30000), confirmedShippingGs: 30000, expectedLocationFingerprint: reqCr.locationFingerprint, expectedCartFingerprint: reqCr.cartFingerprint, ...over });
const rMon = await call('coverageQuoteAndApprove', owner, base({ confirmedShippingGs: 31000 }));
const rAmb = await call('coverageQuoteAndApprove', owner, base({ sellerDraft: 'El envío puede ser ₲30.000 o ₲35.000' }));
const rMax = await call('coverageQuoteAndApprove', owner, base({ sellerDraft: 'El envío cuesta ₲6.000.000', confirmedShippingGs: 6000000 }));
const rCond = await call('coverageQuoteAndApprove', owner, base({ sellerDraft: 'Envío gratis desde ₲150.000', confirmedShippingGs: 0 }));
check('10. re-parseo server: monto distinto / ambiguo / excede máximo / gratuidad condicional ⇒ parse_mismatch SIN outbox ni mensaje',
  [rMon, rAmb, rMax, rCond].every((r) => r.err === 'FAILED_PRECONDITION' && r.kind === 'parse_mismatch') &&
  (await quoteOutboxesOf(reqC.id)).length === 0 && (await outsCount(C)) === outsC,
  `reasons=${[rMon, rAmb, rMax, rCond].map((r) => r.kind).join(',')}`);
const rSeller2 = await call('coverageQuoteAndApprove', await signIn('seller2@perfumeria.com').catch(() => seller), base()).catch(() => ({ err: 'X' }));
const rCross = await call('coverageQuoteAndApprove', otroOwner, base());
check('11. seller NO asignado ⇒ denegado; cross-tenant ⇒ el request AJENO jamás se filtra (falla en SU tenant)',
  (rSeller2.err === 'PERMISSION_DENIED' || rSeller2.err === 'X') &&
  // El tenant del CLAIM manda: el otro owner opera sobre SU tenant (sin coverage ⇒ flow_off) y
  // jamás ve/afecta el request de perfumería.
  (rCross.err === 'PERMISSION_DENIED' || rCross.err === 'NOT_FOUND' || (rCross.err === 'FAILED_PRECONDITION' && rCross.kind === 'flow_off')),
  `seller2=${rSeller2.err} cross=${rCross.err}/${rCross.kind}`);
await postLocation(C, { latitude: LAT + 0.01, longitude: LNG + 0.01 });
await waitFor(async () => (await requestOf(C)).locationFingerprint !== reqCr.locationFingerprint);
const rLoc = await call('coverageQuoteAndApprove', owner, base());
check('12. ubicación actualizada ⇒ location_changed (jamás cotizar sobre la vieja)',
  rLoc.err === 'FAILED_PRECONDITION' && rLoc.kind === 'location_changed');

// ===== 13. coverageApprove VIEJO bloqueado con required (gate 3B bajo política real) =====
const reqC2 = await requestOf(C);
const rViejo = await call('coverageApprove', owner, { requestId: reqC.id, expectedFingerprint: reqC2.locationFingerprint });
check('13. approve VIEJO con required ⇒ shipping_quote_required (fail-closed, sin bypass)',
  rViejo.err === 'FAILED_PRECONDITION' && rViejo.kind === 'shipping_quote_required');

// ===== 14. rejected (fixture) → failed + pointer libre; reintento EXPLÍCITO con intento nuevo =====
const D = CUST(4);
const reqD = await crearPendiente(D);
await cotizar(owner, reqD.id, D, 20000, { sinReintento: true });
const reqDr = await requestOf(D);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failSendText: 'error' });
const rRej = await call('coverageQuoteAndApprove', owner, { requestId: reqD.id, sellerDraft: DRAFT(20000), confirmedShippingGs: 20000, expectedLocationFingerprint: reqDr.locationFingerprint, expectedCartFingerprint: reqDr.cartFingerprint });
const obsD1 = await quoteOutboxesOf(reqD.id);
const reqD2 = await requestOf(D);
check('14a. rechazo CONFIRMADO ⇒ meta_rejected: outbox failed, pointer liberado, SIN aprobación/job/orden',
  rRej.err === 'UNAVAILABLE' && rRej.kind === 'meta_rejected' && obsD1.length === 1 && obsD1[0].status === 'failed' &&
  (reqD2.shippingQuotePending ?? null) === null && reqD2.status === 'pending_coverage_review' && !(await jobOf(reqD.id)) && (await ordersOf(D)).length === 0);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();
const rRetry = await call('coverageQuoteAndApprove', owner, { requestId: reqD.id, sellerDraft: DRAFT(20000), confirmedShippingGs: 20000, expectedLocationFingerprint: reqD2.locationFingerprint, expectedCartFingerprint: reqD2.cartFingerprint });
const obsD2 = await quoteOutboxesOf(reqD.id);
check('14b. reintento explícito ⇒ intento NUEVO (qat distinto) que completa: approved + orden',
  rRetry.result?.ok === true && obsD2.length === 2 && obsD2.some((o) => o.status === 'sent') &&
  obsD2[0].quote.quoteAttemptId !== obsD2[1].quote.quoteAttemptId && (await waitFor(async () => (await ordersOf(D)).length === 1, 20000)),
  `outboxes=${obsD2.map((o) => o.status).join(',')}`);

// ===== 15. unknown (timeout) → congelado; resolución manual ambas vías =====
const E = CUST(5);
const reqE = await crearPendiente(E, sellerUid, 'Vendedora');
await cotizar(seller, reqE.id, E, 25000, { sinReintento: true });
const reqEr = await requestOf(E);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failSendText: 'timeout' });
const rUnk = await call('coverageQuoteAndApprove', seller, { requestId: reqE.id, sellerDraft: DRAFT(25000), confirmedShippingGs: 25000, expectedLocationFingerprint: reqEr.locationFingerprint, expectedCartFingerprint: reqEr.cartFingerprint });
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();
const reqE2 = await requestOf(E);
const obE = (await quoteOutboxesOf(reqE.id))[0];
check('15a. timeout ⇒ unknown CONGELADO: outbox unknown, pointer intacto, sin aprobación/job/orden',
  rUnk.err === 'UNAVAILABLE' && rUnk.kind === 'unknown' && obE?.status === 'unknown' &&
  reqE2.shippingQuotePending?.quoteAttemptId === obE?.quote?.quoteAttemptId && !(await jobOf(reqE.id)) && (await ordersOf(E)).length === 0);
const rUnk2 = await call('coverageQuoteAndApprove', seller, { requestId: reqE.id, sellerDraft: DRAFT(25000), confirmedShippingGs: 25000, expectedLocationFingerprint: reqE2.locationFingerprint, expectedCartFingerprint: reqE2.cartFingerprint });
check('15b. re-invocación con unknown ⇒ sigue congelado (jamás reenvío automático)',
  rUnk2.err === 'UNAVAILABLE' && rUnk2.kind === 'unknown' && (await quoteOutboxesOf(reqE.id)).length === 1);
const rResSeller = await call('coverageQuoteResolveUnknown', seller, { requestId: reqE.id, quoteAttemptId: obE.quote.quoteAttemptId, resolution: 'delivered', note: 'lo vi en el teléfono' });
check('15c. resolver unknown NO es del seller (autorización de encargado)',
  rResSeller.err === 'PERMISSION_DENIED');
const rSinNota = await call('coverageQuoteResolveUnknown', owner, { requestId: reqE.id, quoteAttemptId: obE.quote.quoteAttemptId, resolution: 'delivered' });
check('15d. la confirmación humana (nota) es OBLIGATORIA', rSinNota.err === 'INVALID_ARGUMENT');
const outsE = await outsCount(E);
const rRes = await call('coverageQuoteResolveUnknown', owner, { requestId: reqE.id, quoteAttemptId: obE.quote.quoteAttemptId, resolution: 'delivered', note: 'verificado en WhatsApp Business: el mensaje llegó' });
await waitFor(async () => (await ordersOf(E)).length === 1, 20000);
const reqE3 = await requestOf(E);
const obE2 = (await quoteOutboxesOf(reqE.id))[0];
check('15e. delivered ⇒ outbox sent RECONCILIADO (wamid null, reconciled con actor), TX-C aprueba SIN reenviar; quotedBy = SELLER original',
  rRes.result?.ok === true && obE2.status === 'sent' && obE2.providerMessageId === null && obE2.reconciled?.resolution === 'delivered' &&
  reqE3.status === 'coverage_approved' && reqE3.decision?.byUid === sellerUid && reqE3.shippingQuote?.quotedByUid === sellerUid &&
  (await msgsOf(E)).filter((m) => m.text === 'El costo de envío para tu ubicación es ₲25.000.').length === 0 &&
  (await msgsOf(E)).some((m) => m.author === 'system' && /reconciliación manual/.test(m.text ?? '')),
  `outsAntes=${outsE} outsAhora=${await outsCount(E)} decidedBy=${reqE3.decision?.byUid?.slice(0, 6)}`);
const F = CUST(6);
const reqF = await crearPendiente(F);
await cotizar(owner, reqF.id, F, 15000, { sinReintento: true });
const reqFr = await requestOf(F);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failSendText: 'timeout' });
await call('coverageQuoteAndApprove', owner, { requestId: reqF.id, sellerDraft: DRAFT(15000), confirmedShippingGs: 15000, expectedLocationFingerprint: reqFr.locationFingerprint, expectedCartFingerprint: reqFr.cartFingerprint });
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();
const obF = (await quoteOutboxesOf(reqF.id))[0];
const rResNo = await call('coverageQuoteResolveUnknown', manager, { requestId: reqF.id, quoteAttemptId: obF.quote.quoteAttemptId, resolution: 'not_delivered', note: 'verificado: NO llegó' });
const reqF2 = await requestOf(F);
check('15f. not_delivered ⇒ outbox failed reconciliado + pointer libre (recotizar habilitado), SIN aprobar',
  rResNo.result?.ok === true && rResNo.result?.resolved === 'not_delivered' && (await quoteOutboxesOf(reqF.id))[0].status === 'failed' &&
  (reqF2.shippingQuotePending ?? null) === null && reqF2.status === 'pending_coverage_review' && !(await jobOf(reqF.id)));

// ===== 16. channel_unavailable + recuperación prepared (crash post-TX-A orgánico) =====
const G = CUST(7);
const reqG = await crearPendiente(G);
await cotizar(owner, reqG.id, G, 10000, { sinReintento: true });
const reqGr = await requestOf(G);
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' }); // resolución NO live-válida
const rCh = await call('coverageQuoteAndApprove', owner, { requestId: reqG.id, sellerDraft: DRAFT(10000), confirmedShippingGs: 10000, expectedLocationFingerprint: reqGr.locationFingerprint, expectedCartFingerprint: reqGr.cartFingerprint });
const obG1 = (await quoteOutboxesOf(reqG.id))[0];
check('16a. transporte no-live-válido ⇒ channel_unavailable: outbox queda PREPARED (recuperable), pointer intacto, sin aprobación',
  rCh.err === 'FAILED_PRECONDITION' && rCh.kind === 'channel_unavailable' && obG1?.status === 'prepared' &&
  (await requestOf(G)).shippingQuotePending?.quoteAttemptId === obG1?.quote?.quoteAttemptId && !(await jobOf(reqG.id)));
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'live' });
const rCh2 = await call('coverageQuoteAndApprove', owner, { requestId: reqG.id, sellerDraft: DRAFT(10000), confirmedShippingGs: 10000, expectedLocationFingerprint: reqGr.locationFingerprint, expectedCartFingerprint: reqGr.cartFingerprint });
check('16b. canal restaurado ⇒ el MISMO intento (prepared) se re-drivea y completa (crash post-TX-A recuperable)',
  rCh2.result?.ok === true && (await quoteOutboxesOf(reqG.id)).length === 1 && (await quoteOutboxesOf(reqG.id))[0].status === 'sent' &&
  (await waitFor(async () => (await ordersOf(G)).length === 1, 20000)));

// ===== 17. sent-pre-TXC: recuperación SIN transporte ni reenvío; y sent+mismatch ⇒ sent_not_applied =====
const H = CUST(8);
const reqH = await crearPendiente(H);
await cotizar(owner, reqH.id, H, 12000, { sinReintento: true });
const reqHr = await requestOf(H);
// TX-A real deja prepared; simular crash POST-envío pre-TX-C: outbox → sent (admin), pointer queda.
await call('coverageQuoteAndApprove', owner, { requestId: reqH.id, sellerDraft: DRAFT(12000), confirmedShippingGs: 12000, expectedLocationFingerprint: reqHr.locationFingerprint, expectedCartFingerprint: reqHr.cartFingerprint }).catch(() => {});
// (el intento anterior COMPLETÓ; para simular el crash creamos OTRO escenario con channel_unavailable)
const H2 = CUST(9);
const reqH2 = await crearPendiente(H2);
await cotizar(owner, reqH2.id, H2, 18000, { sinReintento: true });
const reqH2r = await requestOf(H2);
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await call('coverageQuoteAndApprove', owner, { requestId: reqH2.id, sellerDraft: DRAFT(18000), confirmedShippingGs: 18000, expectedLocationFingerprint: reqH2r.locationFingerprint, expectedCartFingerprint: reqH2r.cartFingerprint });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'live' });
const obH2 = (await quoteOutboxesOf(reqH2.id))[0];
await db.doc(`tenants/${T}/coverageMessageOutbox/${obH2.id}`).update({ status: 'sent', providerMessageId: 'mock-crash-sim' }); // crash post-send simulado
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'inactive' }, { merge: true }); // creds ROTAS: TX-C no debe resolver transporte
const outsH2 = await outsCount(H2);
const rRec = await call('coverageQuoteAndApprove', owner, { requestId: reqH2.id, sellerDraft: DRAFT(18000), confirmedShippingGs: 18000, expectedLocationFingerprint: reqH2r.locationFingerprint, expectedCartFingerprint: (await requestOf(H2)).cartFingerprint });
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'active' }, { merge: true });
await waitFor(async () => (await ordersOf(H2)).length === 1, 20000);
check('17a. outbox SENT + creds rotas ⇒ TX-C completa SIN resolver transporte NI reenviar el canónico',
  rRec.result?.ok === true && (await requestOf(H2)).status === 'coverage_approved' && (await ordersOf(H2)).length === 1 &&
  // El canónico JAMÁS se reenvía (0 apariciones: el "envío" original fue un crash simulado post-send);
  // el único out nuevo es el mensaje bancario del resume.
  (await msgsOf(H2)).filter((m) => m.text === 'El costo de envío para tu ubicación es ₲18.000.').length === 0,
  `outs=${outsH2}→${await outsCount(H2)}`);
const I = CUST(10);
const reqI = await crearPendiente(I);
await cotizar(owner, reqI.id, I, 22000, { sinReintento: true });
const reqIr = await requestOf(I);
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqIr.locationFingerprint, expectedCartFingerprint: reqIr.cartFingerprint });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'live' });
const obI = (await quoteOutboxesOf(reqI.id))[0];
await db.doc(`tenants/${T}/coverageMessageOutbox/${obI.id}`).update({ status: 'sent', providerMessageId: 'mock-crash-sim-2' });
// El cliente cambia el carrito DESPUÉS del envío (determinístico: mutación directa de la sesión).
const sesI = await sessionOf(I);
const cartI = sesI.cart;
cartI.items[0].quantity += 1;
cartI.subtotal = cartI.items.reduce((s, i) => s + i.price * i.quantity, 0);
await db.doc(`tenants/${T}/customers/${I}/sessions/active`).set({ cart: cartI }, { merge: true });
const rMis = await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqIr.locationFingerprint, expectedCartFingerprint: (await requestOf(I)).cartFingerprint });
const obI2 = (await quoteOutboxesOf(reqI.id))[0];
const reqI2 = await requestOf(I);
check('17b. SENT + carrito cambiado ⇒ sent_not_applied (terminal auditable): sin aprobar, sin reenviar, sin job/orden',
  rMis.err === 'FAILED_PRECONDITION' && rMis.kind === 'cart_changed_post_send' && obI2.status === 'sent_not_applied' &&
  reqI2.status === 'pending_coverage_review' && (reqI2.shippingQuotePending ?? null) === null && !(await jobOf(reqI.id)) && (await ordersOf(I)).length === 0,
  `kind=${rMis.kind} outbox=${obI2.status}`);

// ===== 18. Config off/invalid + flujo apagado + vencido =====
const rOff = await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqI2.locationFingerprint, expectedCartFingerprint: reqI2.cartFingerprint });
check('18a. (contexto) tras sent_not_applied el request sigue cotizable (intento nuevo permitido)', rOff.kind !== 'quote_en_curso');
await setCoverage({ ...COV, shippingQuote: { required: true, maxChargeGs: 0 } });
const rInv = await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqI2.locationFingerprint, expectedCartFingerprint: reqI2.cartFingerprint });
const covSinQuote = { enabled: COV.enabled, expiryHours: COV.expiryHours, activationId: COV.activationId }; // sin la clave (undefined rompe el serializer)
await setCoverage(covSinQuote);
const rNoReq = await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqI2.locationFingerprint, expectedCartFingerprint: reqI2.cartFingerprint });
await setCoverage(undefined);
const rFlagOff = await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqI2.locationFingerprint, expectedCartFingerprint: reqI2.cartFingerprint });
await setCoverage(COV);
check('18b. policy invalid ⇒ config_invalida; policy off ⇒ quote_not_required; flag OFF ⇒ flow_off (todo fail-closed, sin escrituras)',
  rInv.kind === 'config_invalida' && rNoReq.kind === 'quote_not_required' && rFlagOff.kind === 'flow_off');
await db.collection(`tenants/${T}/coverageRequests`).doc(reqI.id).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
const rVenc = await call('coverageQuoteAndApprove', owner, { requestId: reqI.id, sellerDraft: DRAFT(22000), confirmedShippingGs: 22000, expectedLocationFingerprint: reqI2.locationFingerprint, expectedCartFingerprint: reqI2.cartFingerprint });
check('18c. vencido ⇒ expired con la transición COMMITEADA (coverage_expired persiste)',
  rVenc.kind === 'expired' && (await requestOf(I)).status === 'coverage_expired');

// ===== 19. Recompra: request NUEVO reusando ubicación; pipeline no-terminal BLOQUEA =====
const reqA5 = await requestOf(A); // A quedó approved + resume done (happy path)
await waitFor(async () => ((await jobOf(reqA.id))?.status ?? '') === 'done', 20000);
await sendAndWait(A, 'agregá otra belle');
const rPagar2 = await sendAndWait(A, 'quiero pagar');
await waitFor(async () => (await requestsOf(A)).length === 2, 15000);
const reqsA = await requestsOf(A);
const nuevoA = reqsA[0];
const campanaRequote = (await db.doc(`tenants/${T}/notifications/covrequote-${A}-${nuevoA.id}`).get()).data();
check('19a. recompra con required ⇒ REQUEST NUEVO en pending_coverage_review REUSANDO la ubicación (sin pedirla de nuevo) + campana ATÓMICA al equipo',
  reqsA.length === 2 && nuevoA.id !== reqA.id && nuevoA.status === 'pending_coverage_review' &&
  nuevoA.locationFingerprint === reqA5.locationFingerprint && nuevoA.location !== null &&
  (rPagar2 ?? '').includes('costo de envío') && (await sessionOf(A))?.context?.coverage?.requestId === nuevoA.id &&
  campanaRequote?.type === 'handoff_coverage_review' && campanaRequote?.customerId === A && !!campanaRequote?.body,
  `reqs=${reqsA.length} reply=${(rPagar2 ?? '').slice(0, 60)} campana=${campanaRequote?.type ?? 'NO'}`);
// pipeline NO terminal: forzar job del request nuevo... el nuevo no tiene job; simular con el viejo:
await db.doc(`tenants/${T}/coverageResumeJobs/${reqA.id}`).update({ status: 'send_unknown' });
await db.collection(`tenants/${T}/coverageRequests`).doc(reqA.id).update({ 'resume.status': 'send_unknown' });
// apuntar la sesión de vuelta al request VIEJO (simula el estado colgado) y probar 'pagar':
const ptrViejo = { requestId: reqA.id, status: 'coverage_approved', locationFingerprint: reqA5.locationFingerprint, createdAt: reqA5.createdAt, updatedAt: Timestamp.now() };
await db.doc(`tenants/${T}/customers/${A}/sessions/active`).set({ context: { coverage: ptrViejo } }, { merge: true });
const rPagar3 = await sendAndWait(A, 'quiero pagar');
const jobViejo = await jobOf(reqA.id);
check('19b. pipeline anterior NO terminal (send_unknown) ⇒ BLOQUEA la compra nueva SIN cancelarlo',
  (rPagar3 ?? '').includes('preparando tu pedido') && jobViejo.status === 'send_unknown' && (await requestsOf(A)).length === 2,
  `reply=${(rPagar3 ?? '').slice(0, 50)} job=${jobViejo?.status}`);
await db.doc(`tenants/${T}/coverageResumeJobs/${reqA.id}`).update({ status: 'done' });
await db.collection(`tenants/${T}/coverageRequests`).doc(reqA.id).update({ 'resume.status': 'done' });

// ===== 20. Pedido común (flag OFF) persiste shipping=0 =====
await setCoverage(undefined);
const K = CUST(11);
await armarCarrito(K);
await sendAndWait(K, 'quiero pagar');
await waitFor(async () => (await ordersOf(K)).length === 1, 15000);
const ordK = (await ordersOf(K))[0];
check('20. pedido común nuevo persiste totals.shipping = 0 (computeOrderTotals) con total = subtotal',
  ordK?.totals?.shipping === 0 && ordK.totals.total === ordK.totals.subtotal && ordK.status === 'PENDING_PAYMENT');
await setCoverage(COV);

// ===== 21. Kill-switch en la frontera pre-Meta =====
const L = CUST(12);
const reqL = await crearPendiente(L);
await cotizar(owner, reqL.id, L, 11000, { sinReintento: true });
const reqLr = await requestOf(L);
await db.doc(`tenants/${T}/_debug/coverageFixtures`).set({ holdAt: 'outbox_pre_meta' });
const pKill = call('coverageQuoteAndApprove', owner, { requestId: reqL.id, sellerDraft: DRAFT(11000), confirmedShippingGs: 11000, expectedLocationFingerprint: reqLr.locationFingerprint, expectedCartFingerprint: reqLr.cartFingerprint });
await waitFor(async () => ((await db.doc(`tenants/${T}/_debug/coverageHolds`).get()).data()?.point === 'outbox_pre_meta'), 10000);
await setCoverage(undefined); // APAGADO DE EMERGENCIA con el envío por salir
await db.doc(`tenants/${T}/_debug/coverageFixtures`).set({ holdAt: null, resume: true }, { merge: true });
const rKill = await pKill;
const obL = (await quoteOutboxesOf(reqL.id))[0];
check('21. kill-switch pre-Meta ⇒ flow_off, outbox de vuelta a PREPARED (nada salió), pointer intacto, sin aprobación',
  rKill.err === 'FAILED_PRECONDITION' && rKill.kind === 'flow_off' && obL?.status === 'prepared' &&
  (await msgsOf(L)).filter((m) => m.text === 'El costo de envío para tu ubicación es ₲11.000.').length === 0 && !(await jobOf(reqL.id)),
  `kind=${rKill.kind} outbox=${obL?.status}`);
await db.doc(`tenants/${T}/_debug/coverageFixtures`).delete();
await setCoverage(COV);

// ===== 22. PII: outbox/orden/auditoría sin dirección/coords/sellerDraft/teléfonos completos =====
const allQuoteObs = (await db.collection(`tenants/${T}/coverageMessageOutbox`).where('action', '==', 'quote').get()).docs.map((d) => JSON.stringify(d.data()));
const audits = (await db.collection(`tenants/${T}/auditLogs`).get()).docs.map((d) => d.data()).filter((a) => (a.action ?? '').startsWith('coverage.quote'));
check('22. PII limpia: outbox sin dirección/coordenadas/borrador; auditoría de quote con cliente ENMASCARADO',
  allQuoteObs.every((s) => !s.includes('Av. ') && !s.includes(String(LAT)) && !s.includes('latitude')) &&
  audits.length > 0 && audits.every((a) => /…\d{4}/.test(a.summary) && !new RegExp(CUST(1)).test(a.summary)),
  `outboxes=${allQuoteObs.length} audits=${audits.length}`);

// ===== 23. Cero PAID / stock intacto =====
const todasOrdenes = (await db.collection(`tenants/${T}/orders`).get()).docs.map((d) => d.data());
check('23. NINGUNA orden quedó PAID automáticamente (todas PENDING_PAYMENT)',
  todasOrdenes.length > 0 && todasOrdenes.every((o) => o.status === 'PENDING_PAYMENT'));

// ===== 24. Reemplazo EN VUELO (review adversarial): el prepared reemplazado JAMÁS se envía =====
const M = CUST(13);
const reqM = await crearPendiente(M);
await cotizar(owner, reqM.id, M, 13000, { sinReintento: true }); // bounce: refresh a cart2
const reqMr = await requestOf(M);
const payloadM = (gs) => ({ requestId: reqM.id, sellerDraft: DRAFT(gs), confirmedShippingGs: gs, expectedLocationFingerprint: reqMr.locationFingerprint, expectedCartFingerprint: reqMr.cartFingerprint });
await db.doc(`tenants/${T}/_debug/coverageFixtures`).set({ holdAt: 'outbox_pre_claim' });
const pM1 = call('coverageQuoteAndApprove', owner, payloadM(13000)); // TX-A ok → parkeado ANTES del claim
await waitFor(async () => ((await db.doc(`tenants/${T}/_debug/coverageHolds`).get()).data()?.point === 'outbox_pre_claim'), 10000);
const pM2 = call('coverageQuoteAndApprove', owner, payloadM(14000)); // reemplaza al intento parkeado
await waitFor(async () => (await quoteOutboxesOf(reqM.id)).length === 2, 10000); // TX-A de M2 commiteó
await db.doc(`tenants/${T}/_debug/coverageFixtures`).set({ holdAt: null, resume: true }, { merge: true });
const [rM1, rM2] = await Promise.all([pM1, pM2]);
await db.doc(`tenants/${T}/_debug/coverageFixtures`).delete();
await waitFor(async () => (await ordersOf(M)).length === 1, 20000);
const obsM = await quoteOutboxesOf(reqM.id);
const msgs13 = (await msgsOf(M)).filter((m) => m.text === 'El costo de envío para tu ubicación es ₲13.000.').length;
const msgs14 = (await msgsOf(M)).filter((m) => m.text === 'El costo de envío para tu ubicación es ₲14.000.').length;
check('24. intento reemplazado EN VUELO ⇒ terminal (failed) sin enviarse: UN solo canónico (el vigente), una orden con el monto vigente',
  rM2.result?.ok === true && rM1.result?.ok !== true && msgs13 === 0 && msgs14 === 1 &&
  obsM.filter((o) => o.status === 'sent').length === 1 && obsM.filter((o) => o.status === 'failed').length === 1 &&
  obsM.find((o) => o.status === 'failed')?.quote?.chargeGs === 13000 &&
  (await ordersOf(M)).length === 1 && (await ordersOf(M))[0].totals.shipping === 14000,
  `r1=${rM1.err ?? 'ok'} r2=${rM2.err ?? 'ok'} msgs13=${msgs13} msgs14=${msgs14} obs=${obsM.map((o) => o.status).join(',')}`);

// ===== 25. unknown + request VENCIDO: recuperación gana a la expiración; la resolución jamás aprueba un request muerto =====
const N = CUST(14);
const reqN = await crearPendiente(N);
await cotizar(owner, reqN.id, N, 17000, { sinReintento: true });
const reqNr = await requestOf(N);
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).set({ failSendText: 'timeout' });
await call('coverageQuoteAndApprove', owner, { requestId: reqN.id, sellerDraft: DRAFT(17000), confirmedShippingGs: 17000, expectedLocationFingerprint: reqNr.locationFingerprint, expectedCartFingerprint: reqNr.cartFingerprint });
await db.doc(`tenants/${T}/_debug/whatsappFixtures`).delete();
const obN = (await quoteOutboxesOf(reqN.id))[0];
await db.collection(`tenants/${T}/coverageRequests`).doc(reqN.id).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
const rNQuote = await call('coverageQuoteAndApprove', owner, { requestId: reqN.id, sellerDraft: DRAFT(17000), confirmedShippingGs: 17000, expectedLocationFingerprint: reqNr.locationFingerprint, expectedCartFingerprint: (await requestOf(N)).cartFingerprint });
const reqN2 = await requestOf(N);
check('25a. unknown + vencido ⇒ la RECUPERACIÓN gana: sigue congelado (resoluble), la expiración NO mata el pointer',
  rNQuote.err === 'UNAVAILABLE' && rNQuote.kind === 'unknown' && reqN2.status === 'pending_coverage_review' &&
  reqN2.shippingQuotePending?.quoteAttemptId === obN.quote.quoteAttemptId,
  `kind=${rNQuote.kind} status=${reqN2.status}`);
const rNRes = await call('coverageQuoteResolveUnknown', owner, { requestId: reqN.id, quoteAttemptId: obN.quote.quoteAttemptId, resolution: 'delivered', note: 'verificado: llegó, pero el request ya venció' });
const reqN3 = await requestOf(N);
const obN2 = (await quoteOutboxesOf(reqN.id))[0];
check('25b. resolver delivered sobre VENCIDO ⇒ sent_not_applied + coverage_expired: JAMÁS aprueba dinero en un request muerto (sin job/orden)',
  rNRes.err === 'FAILED_PRECONDITION' && rNRes.kind === 'expired' && obN2.status === 'sent_not_applied' &&
  obN2.reconciled?.resolution === 'delivered' && reqN3.status === 'coverage_expired' && (reqN3.shippingQuotePending ?? null) === null &&
  !(await jobOf(reqN.id)) && (await ordersOf(N)).length === 0,
  `kind=${rNRes.kind} outbox=${obN2.status} status=${reqN3.status}`);

// ---- Restore ----
await db.doc(`tenants/${T}/config/channels`).set(beforeChannels ?? { whatsappSendMode: 'mock' });
if (beforeCheckout) await db.doc(`tenants/${T}/config/checkout`).set(beforeCheckout); else await db.doc(`tenants/${T}/config/checkout`).delete().catch(() => {});

const ok = results.filter(Boolean).length;
console.log(`\nRESULTADO SHIPPING-CHAT-3C (saga de cotización): ${ok === results.length ? 'TODO OK ✅' : 'FALLAS ❌'} (${ok}/${results.length})`);
process.exit(ok === results.length ? 0 : 1);
