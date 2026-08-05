/**
 * verify-coexistence-dual.mjs — DOS PNID del MISMO tenant, el MISMO cliente, contra el emulador
 * ==============================================================================================
 * ADR-0017 §2 dice que la conversación es POR CANAL. Este script es la prueba EN EJECUCIÓN que el
 * runbook (Paso 12) exige antes de promover a `live` un número de canal propio: dos números del
 * mismo tenant, un solo cliente escribiéndole a los dos A LA VEZ, con estados comerciales
 * DISTINTOS, y separación total de:
 *
 *   sesión · carrito · takeover · handoff · Coverage · pedido pendiente · comprobantes ·
 *   salida manual · salida del bot
 *
 * Y los tres modos del gate en vivo: `inactive` calla, `shadow` observa sin efectos, `live`
 * responde ÚNICAMENTE por su canal — mientras el número que ya vende sigue vendiendo.
 *
 * REGLA DURA DE ESTE SCRIPT: el PNID nuevo llega a `shadow` y a `live` invocando la herramienta
 * REAL del runbook (`migrarModoAutomatizacion`), jamás escribiendo `automationMode` a mano.
 * Demostrar el gate escribiendo el campo directo probaría un camino que en producción no existe
 * — y escondería que el cutover fuera imposible con la herramienta de verdad. La única escritura
 * directa legítima sería la del PNID legacy (modela el Paso 5 pre-deploy), y acá ni esa se usa:
 * el Paso 5 también entra por la herramienta.
 *
 * NUNCA toca graph.facebook.com: emulador ⇒ cliente Mock + stub de medios. Datos inventados acá.
 *
 * Requiere: emulador (auth+firestore+functions+storage) con `--project demo-aiafg` + seed-users
 * + load-catalog. Re-ejecutable: limpia lo SUYO al empezar y restaura el snapshot al salir.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { masRestrictivo, declaredAutomationMode } from '@vpw/shared';
// La MISMA herramienta que documenta el runbook (Pasos 5, 11 y 12). Importarla —y no reimplementar
// ni escribir el campo a mano— es lo único que hace que este E2E mida el cutover REAL.
import { migrarModoAutomatizacion } from './migrate-whatsapp-automation-mode.mjs';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

// ---------------------------------------------------------------------------
// Fixtures con PREFIJO EXCLUSIVO (9029… / ord-dual-… / MEDIA-DUAL-…): nada de este script puede
// colisionar con el de otro (verify-coexistence usa 9019…).
// ---------------------------------------------------------------------------
const T = 'perfumeria';
const WABA = 'WABA-COEX-DUAL-E2E';
/** El número que HOY vende (conexión heredada `main`, canal `active`). */
const PNID_A = '902900000000001';
/** El número REAL que entra por Coexistence (canal propio `wa_{pnid}`). */
const PNID_B = '902900000000002';
const CANAL_B = `wa_${PNID_B}`;
const TODOS_LOS_PNID = [PNID_A, PNID_B];
/** EL MISMO cliente le escribe a los dos números: ese es el sujeto de todo el script. */
const CUST = '595994200001';
/** wa_id del NEGOCIO (aparece como `from` de un echo; jamás puede volverse cliente). */
const WAID_NEGOCIO = '595994299999';
const TOKEN_STD = 'tok-dual-e2e-STD-NUNCA-persistir';
const TOKEN_COEX = 'tok-dual-e2e-REAL-NUNCA-persistir';
const RUN = Date.now();
const ORD_A = `ord-dual-a-${RUN}`;

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, maxMs = 20_000) => {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { if (await pred()) return true; await sleep(500); }
  return false;
};
const signIn = async (email) => (await (await fetch(AUTH, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
})).json()).idToken;

async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? '' };
}

async function postWebhook(payload) {
  const res = await fetch(`${BASE}/metaWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sobre = (pnid, field, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pnid }, ...value } }] }],
});

let wamidSeq = 0;
const nuevoWamid = (marca) => `wamid.DUAL-${marca}-${RUN}-${++wamidSeq}`;

const inbound = (pnid, texto, wamid) => sobre(pnid, 'messages', {
  contacts: [{ wa_id: CUST, profile: { name: 'Cliente Dual' } }],
  messages: [{ from: CUST, id: wamid ?? nuevoWamid('IN'), timestamp: '1716750000', type: 'text', text: { body: texto } }],
});

const inboundImagen = (pnid, mediaId, wamid) => sobre(pnid, 'messages', {
  contacts: [{ wa_id: CUST, profile: { name: 'Cliente Dual' } }],
  messages: [{ from: CUST, id: wamid, timestamp: '1716750050', type: 'image', image: { id: mediaId, mime_type: 'image/jpeg' } }],
});

/** Echo oficial: `message_echoes`, `from` = NEGOCIO, `to` = cliente (ADR-0017 §3). */
const echo = (pnid, texto, wamid) => sobre(pnid, 'smb_message_echoes', {
  message_echoes: [{ from: WAID_NEGOCIO, to: CUST, id: wamid ?? nuevoWamid('ECHO'), timestamp: '1716750100', type: 'text', text: { body: texto } }],
});

/** Espera a que el TRIGGER termine con el evento (mismo derivador de id que el productor). */
/**
 * Modo EFECTIVO como lo resuelve el gate del webhook: solo las fuentes que DECLARAN votan y gana
 * el más restrictivo. Pasarle el valor crudo a `masRestrictivo` sin filtrar haría votar `inactive`
 * a un índice que simplemente no tiene el campo — que es exactamente lo que el resolvedor evita.
 */
const modoEfectivo = (assetCrudo, indiceCrudo) => {
  const opiniones = [];
  for (const declarado of [declaredAutomationMode(assetCrudo), declaredAutomationMode(indiceCrudo)]) {
    if (declarado !== null) opiniones.push(declarado);
  }
  return masRestrictivo(...opiniones);
};

async function esperarEvento(wamid, maxMs = 25_000) {
  const ref = db.doc(`metaWebhookInbox/whatsapp_${wamid.replace(/[^\w.:=+-]/g, '_').slice(0, 256)}`);
  const fin = Date.now() + maxMs;
  while (Date.now() < fin) {
    const d = (await ref.get()).data();
    if (d && d.processingStatus !== 'received' && d.processingStatus !== 'processing') return d;
    await sleep(400);
  }
  return (await ref.get()).data() ?? null;
}

const sesion = async (key) => (await db.doc(`tenants/${T}/customers/${CUST}/sessions/${key}`).get()).data() ?? null;
const cliente = async () => (await db.doc(`tenants/${T}/customers/${CUST}`).get()).data() ?? null;
const mensajes = async () => (await db.collection(`tenants/${T}/customers/${CUST}/messages`).get()).docs.map((d) => d.data());
const outsDelBot = async (pnid) => (await mensajes()).filter((m) => m.direction === 'out' && m.author === 'bot' && m.receivedVia === pnid).length;
const trazaEnvio = async () => (await db.doc(`tenants/${T}/_debug/lastWhatsappSend`).get()).data() ?? null;
const borrarTraza = () => db.doc(`tenants/${T}/_debug/lastWhatsappSend`).delete().catch(() => {});
const conexion = async (id) => (await db.doc(`tenants/${T}/metaConnections/${id}`).get()).data() ?? null;
const asset = async (pnid) => (await db.doc(`tenants/${T}/metaAssets/${pnid}`).get()).data() ?? null;
const indice = async (pnid) => (await db.doc(`metaExternalIndex/whatsapp_${pnid}`).get()).data() ?? null;
const orden = async (id) => (await db.doc(`tenants/${T}/orders/${id}`).get()).data() ?? null;
const adjuntosDe = async () => (await db.collection(`tenants/${T}/attachments`).where('customerId', '==', CUST).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const borrarDocs = async (snap) => { for (const d of snap.docs) await d.ref.delete().catch(() => {}); };

const fixtureGraph = async (phoneNumbers, extra = {}) => db.doc('metaTestFixtures/graph').set({
  accessToken: extra.accessToken ?? TOKEN_STD,
  isValid: true,
  scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
  wabaIds: [WABA],
  tokenExpiresAtMs: null,
  phoneNumbers,
});
const telefono = (id, display) => ({ id, displayPhoneNumber: display, verifiedName: 'Dual E2E', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' });

/** Sesión sembrada con forma canónica; `key` ES el id del documento (ADR-0017 §2). */
const setSesion = (key, over = {}) =>
  db.doc(`tenants/${T}/customers/${CUST}/sessions/${key}`).set({
    id: key, tenantId: T, customerId: CUST, state: 'IDLE',
    cart: { items: [], subtotal: 0 }, context: {}, updatedAt: Timestamp.now(), ...over,
  });

// ---------------------------------------------------------------------------
// SNAPSHOT + LIMPIEZA INICIAL (re-ejecutable). Todo lo del tenant vuelve al final.
// ---------------------------------------------------------------------------
const snap = {
  tenant: (await db.doc(`tenants/${T}`).get()).data() ?? null,
  assets: (await db.collection(`tenants/${T}/metaAssets`).get()).docs.map((d) => ({ id: d.id, data: d.data() })),
  conns: (await db.collection(`tenants/${T}/metaConnections`).get()).docs.map((d) => ({ id: d.id, data: d.data() })),
  idx: (await db.collection('metaExternalIndex').where('tenantId', '==', T).get()).docs.map((d) => ({ id: d.id, data: d.data() })),
  channels: (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null,
  agent: (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null,
  attachmentsCfg: (await db.doc(`tenants/${T}/config/attachments`).get()).data() ?? null,
  receiptGateCfg: (await db.doc(`tenants/${T}/config/receiptGate`).get()).data() ?? null,
  graphFx: (await db.doc('metaTestFixtures/graph').get()).data() ?? null,
  secreto: (await db.doc(`secrets/meta-token-${T}`).get()).data() ?? null,
};

/** Borra TODO lo que este script pudo dejar (propio por prefijo). Se llama al empezar y al final. */
async function limpiarFixturesPropios() {
  for (const pnid of TODOS_LOS_PNID) {
    await db.doc(`tenants/${T}/metaAssets/${pnid}`).delete().catch(() => {});
    await db.doc(`tenants/${T}/metaConnections/wa_${pnid}`).delete().catch(() => {});
    await db.doc(`secrets/meta-token-${T}-${pnid}`).delete().catch(() => {});
    await db.doc(`metaExternalIndex/whatsapp_${pnid}`).delete().catch(() => {});
    for (const col of ['metaWebhookInbox', 'metaWebhookHistory', 'metaWebhookAppState']) {
      await borrarDocs(await db.collection(col).where('externalId', '==', pnid).get());
    }
    await borrarDocs(await db.collection('metaWebhookShadow').where('phoneNumberId', '==', pnid).get());
  }
  for (const c of [CUST, WAID_NEGOCIO]) {
    await borrarDocs(await db.collection(`tenants/${T}/customers/${c}/messages`).get());
    await borrarDocs(await db.collection(`tenants/${T}/customers/${c}/sessions`).get());
    await db.doc(`tenants/${T}/customers/${c}`).delete().catch(() => {});
  }
  await borrarDocs(await db.collection(`tenants/${T}/orders`).where('source', '==', 'verify-coexistence-dual').get());
  await borrarDocs(await db.collection(`tenants/${T}/attachments`).where('customerId', '==', CUST).get());
  await borrarDocs(await db.collection(`tenants/${T}/auditLogs`).where('targetId', 'in', [...TODOS_LOS_PNID, CUST]).get());
  await borrarTraza();
  await borrarDocs(await db.collection('metaOAuthStates').where('tenantId', '==', T).get());
}
await limpiarFixturesPropios();

// Plan con cupo para 2 números; envío en modo live (en emulador es SIEMPRE Mock, cero Graph);
// bot encendido; ingesta de adjuntos ON (para los comprobantes). La cache de entitlements dura
// 30 s en memoria: se escribe UNA vez y se espera, como en verify-coexistence.
await db.doc(`tenants/${T}`).set({
  planId: 'growth',
  subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
  limitOverrides: { maxWhatsappNumbers: 8 },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() },
}, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'live' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot del E2E dual' }, { merge: true });
await db.doc(`tenants/${T}/config/attachments`).set({ ingest: { enabled: true } }, { merge: true });
// NIVEL B de ADR-0016 (default APAGADO): sin esto ningún archivo puede proponerse como
// comprobante y el check 19 mediría el rollout, no el aislamiento por canal.
await db.doc(`tenants/${T}/config/receiptGate`).set({ enabled: true });
console.log('   (esperando 31s a que expire la cache de entitlements…)');
await sleep(31_000);

const owner = await signIn('owner@perfumeria.com');

// ===========================================================================
// 1-3. ALTA: estándar para A (+ Paso 5 con la herramienta real), Coexistence para B
// ===========================================================================
await fixtureGraph([telefono(PNID_A, '+595 992 900 001')]);
const n1 = await call('startMetaConnect', owner, { tenantId: T, mode: 'standard' });
const r1 = await call('connectMeta', owner, {
  tenantId: T, mode: 'standard', nonce: n1.result?.nonce, code: 'code-dual-std-1',
  wabaId: WABA, businessId: 'BIZ-DUAL', businessName: 'Perfumería Dual',
});
const assetA = await asset(PNID_A);
check('1. el número que vende queda conectado por la vía estándar: `main` activa, `selected`, ruteando',
  r1.result?.ok === true && r1.result?.phoneNumberId === PNID_A && (await conexion('main'))?.status === 'active' &&
  assetA?.selected === true && assetA?.connectionId === 'main' && (await indice(PNID_A))?.tenantId === T,
  `err=${r1.err} conn=${(await conexion('main'))?.status}`);

// Paso 5 del runbook, con la MISMA herramienta (ni siquiera el legacy se escribe a mano acá).
const rLiveA = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_A, mode: 'live', apply: true });
check('2. Paso 5 por la herramienta real: el legacy pasa a `live` (asset; el índice no declara)',
  rLiveA.outcome === 'written' && rLiveA.indice === 'no_declara' &&
  modoEfectivo((await asset(PNID_A))?.automationMode, (await indice(PNID_A))?.automationMode) === 'live',
  `outcome=${rLiveA.outcome} indice=${rLiveA.indice}`);

const mainAntes = JSON.stringify(await conexion('main'));
const assetAAntes = JSON.stringify(await asset(PNID_A));
await fixtureGraph([telefono(PNID_A, '+595 992 900 001'), telefono(PNID_B, '+595 992 900 002')], { accessToken: TOKEN_COEX });
const nC = await call('coexistenceStart', owner, { tenantId: T });
const rC = await call('coexistenceConnect', owner, {
  tenantId: T, nonce: nC.result?.nonce, code: 'code-dual-coex-1',
  wabaId: WABA, phoneNumberId: PNID_B, businessId: 'BIZ-DUAL', businessName: 'Perfumería Dual',
});
const assetB = await asset(PNID_B);
check('3. el número real nace por Coexistence: MUDO, no seleccionado, canal PROPIO y `main` intacto',
  rC.result?.ok === true && assetB?.automationMode === undefined && assetB?.selected === false &&
  assetB?.sessionKey === CANAL_B && assetB?.connectionId === CANAL_B &&
  JSON.stringify(await conexion('main')) === mainAntes && JSON.stringify(await asset(PNID_A)) === assetAAntes,
  `err=${rC.err} sessionKey=${assetB?.sessionKey}`);

// ===========================================================================
// 4-5. `inactive` CALLA — y el número actual vende igual
// ===========================================================================
const wamidInactive = nuevoWamid('IN-B-INACTIVE');
await postWebhook(inbound(PNID_B, 'hola, probando el número nuevo', wamidInactive));
const evInactive = await esperarEvento(wamidInactive);
check('4. `inactive`: ACK y nada más — evento cerrado con motivo, sin cliente, sin mensajes, sin envío',
  evInactive?.processingStatus === 'ignored' && evInactive?.automationMode === 'inactive' &&
  (await cliente()) === null && (await mensajes()).length === 0 && (await trazaEnvio()) === null,
  `status=${evInactive?.processingStatus} mode=${evInactive?.automationMode}`);

const wamidA1 = nuevoWamid('IN-A-1');
await postWebhook(inbound(PNID_A, 'hola', wamidA1));
const contestoA1 = await waitFor(async () => (await outsDelBot(PNID_A)) >= 1);
check('5. con B `inactive`, el número que vende CONTESTA por su canal (out del bot vía A)',
  contestoA1 && (await trazaEnvio())?.phoneNumberId === PNID_A,
  `contesto=${contestoA1} via=${(await trazaEnvio())?.phoneNumberId}`);

// ===========================================================================
// 6-7. `shadow` OBSERVA SIN EFECTOS — herramienta real, y el actual sigue vendiendo
// ===========================================================================
const rShadowB = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_B, mode: 'shadow', apply: true });
await borrarTraza();
const wamidShadow = nuevoWamid('IN-B-SHADOW');
await postWebhook(inbound(PNID_B, 'esto se mira, no se contesta', wamidShadow));
const huboSombra = await waitFor(async () =>
  (await db.collection('metaWebhookShadow').where('phoneNumberId', '==', PNID_B).get()).size > 0, 15_000);
const sombra = (await db.collection('metaWebhookShadow').where('phoneNumberId', '==', PNID_B).get()).docs.map((d) => d.data())[0];
check('6. `shadow` por la herramienta real: observación en superficie propia con el canal de B, y NADA más',
  rShadowB.outcome === 'written' && huboSombra && sombra?.sessionKey === CANAL_B && sombra?.tenantId === T &&
  (await mensajes()).every((m) => m.receivedVia !== PNID_B) && (await trazaEnvio()) === null,
  `migracion=${rShadowB.outcome} obs=${huboSombra} sessionKey=${sombra?.sessionKey}`);
check('7. `shadow` no toca el resumen del cliente: `receivedVia` sigue siendo el del número que vende',
  (await cliente())?.conversation?.receivedVia === PNID_A,
  `receivedVia=${(await cliente())?.conversation?.receivedVia}`);

// ===========================================================================
// 8-10. `live` SOLO POR LA HERRAMIENTA REAL (el ex-rojo del programa)
// ===========================================================================
/**
 * EL CHECK QUE DOCUMENTA EL DEFECTO: contra `9413047`, `migrarModoAutomatizacion(live)` sobre un
 * PNID de canal propio devolvía `sesion_por_canal_no_migrada` — el cutover del programa era
 * imposible con la herramienta real y solo "funcionaba" escribiendo el campo a mano en los E2E.
 */
const rLiveB = await migrarModoAutomatizacion(db, { tenantId: T, phoneNumberId: PNID_B, mode: 'live', apply: true });
check('8. Paso 12 por la herramienta REAL: el PNID de canal propio (no seleccionado) llega a `live`',
  rLiveB.outcome === 'written' &&
  modoEfectivo((await asset(PNID_B))?.automationMode, (await indice(PNID_B))?.automationMode) === 'live',
  `outcome=${rLiveB.outcome}`);

await borrarTraza();
const wamidB1 = nuevoWamid('IN-B-LIVE');
await postWebhook(inbound(PNID_B, 'hola', wamidB1));
const contestoB1 = await waitFor(async () => (await outsDelBot(PNID_B)) >= 1);
check('9. `live` responde ÚNICAMENTE por su canal: out del bot vía B, credenciales de B',
  contestoB1 && (await trazaEnvio())?.phoneNumberId === PNID_B,
  `contesto=${contestoB1} via=${(await trazaEnvio())?.phoneNumberId}`);
const sesA0 = await sesion('active');
const sesB0 = await sesion(CANAL_B);
check('10. DOS conversaciones: cada número tiene su documento de sesión y cada uno sabe cuál es',
  sesA0?.id === 'active' && sesB0?.id === CANAL_B,
  `A=${sesA0?.id} B=${sesB0?.id}`);

// ===========================================================================
// 11-12. ESTADOS COMERCIALES DISTINTOS, SIMULTÁNEOS Y AISLADOS (las dos direcciones)
// ===========================================================================
/**
 * El canal que vende queda en pleno checkout (AWAITING_PAYMENT + carrito + pedido + oferta +
 * puntero de Coverage) y el canal nuevo en otra cosa (BROWSING + su propio pedido y su propio
 * puntero). Un turno de CADA número no puede ni leer ni pisar el estado del otro: se compara el
 * documento ENTERO byte a byte, no campos sueltos.
 */
await setSesion('active', {
  state: 'AWAITING_PAYMENT',
  cart: { items: [{ sku: 'DUAL-SKU-A', name: 'Perfume canal A', qty: 2, unitPrice: 100_000 }], subtotal: 200_000 },
  context: {
    pendingOrderId: ORD_A,
    pendingCartConfirmation: { sku: 'DUAL-SKU-A', qty: 1 },
    coverage: { requestId: 'cov-dual-a', status: 'awaiting_location' },
  },
});
await setSesion(CANAL_B, {
  state: 'BROWSING',
  cart: { items: [{ sku: 'DUAL-SKU-B', name: 'Perfume canal B', qty: 1, unitPrice: 50_000 }], subtotal: 50_000 },
  context: {
    pendingOrderId: `ord-dual-b-${RUN}`,
    coverage: { requestId: 'cov-dual-b', status: 'pending_coverage_review' },
  },
});
const snapSesA = JSON.stringify(await sesion('active'));
const wamidB2 = nuevoWamid('IN-B-CAT');
await postWebhook(inbound(PNID_B, 'quiero ver el catálogo', wamidB2));
await esperarEvento(wamidB2);
await sleep(2000); // margen: el turno persiste sesión/mensajes después de marcar el evento
check('11. un turno del número nuevo NO lee ni pisa el checkout del que vende: sesión A IDÉNTICA byte a byte',
  JSON.stringify(await sesion('active')) === snapSesA,
  `state=${(await sesion('active'))?.state} pending=${(await sesion('active'))?.context?.pendingOrderId}`);

const snapSesB = JSON.stringify(await sesion(CANAL_B));
const wamidA2 = nuevoWamid('IN-A-2');
await postWebhook(inbound(PNID_A, 'sigo acá', wamidA2));
await esperarEvento(wamidA2);
await sleep(2000);
const sesBTras = await sesion(CANAL_B);
check('12. y al revés: un turno del que vende NO toca la sesión de B (pedido y Coverage propios intactos)',
  JSON.stringify(sesBTras) === snapSesB && sesBTras?.context?.pendingOrderId === `ord-dual-b-${RUN}` &&
  sesBTras?.context?.coverage?.requestId === 'cov-dual-b',
  `pendingB=${sesBTras?.context?.pendingOrderId}`);

// ===========================================================================
// 13-17. TAKEOVER / HANDOFF / SALIDA MANUAL / SALIDA DEL BOT — POR CANAL
// ===========================================================================
// Estados limpios: el sujeto ahora es quién atiende, no el carrito.
await setSesion('active');
await setSesion(CANAL_B);

// El vendedor contesta DESDE SU TELÉFONO por el número real: echo → takeover de ESE canal.
await postWebhook(echo(PNID_B, 'Hola! te escribo yo desde el celular'));
const takeoverB = await waitFor(async () => (await sesion(CANAL_B))?.context?.humanTakeover === true, 15_000);
const sesATrasEcho = await sesion('active');
const burbujasEcho = (await mensajes()).filter((m) => m.origin === 'whatsapp_business_app');
check('13. el echo activa el takeover SOLO en el canal del número real (handoff `seller_manual` en B, A libre)',
  takeoverB && (await sesion(CANAL_B))?.context?.handoffReason === 'seller_manual' &&
  sesATrasEcho?.context?.humanTakeover !== true && (sesATrasEcho?.context?.handoffReason ?? null) === null &&
  burbujasEcho.length === 1 && burbujasEcho[0]?.author === 'seller' && burbujasEcho[0]?.receivedVia === PNID_B,
  `takeoverB=${takeoverB} burbujas=${burbujasEcho.length}`);

const outsB13 = await outsDelBot(PNID_B);
const outsA13 = await outsDelBot(PNID_A);
const wamidB3 = nuevoWamid('IN-B-TOMADO');
await postWebhook(inbound(PNID_B, 'seguís ahí?', wamidB3));
await esperarEvento(wamidB3);
const wamidA3 = nuevoWamid('IN-A-3');
await postWebhook(inbound(PNID_A, 'hola de nuevo', wamidA3));
await waitFor(async () => (await outsDelBot(PNID_A)) > outsA13);
await sleep(2500);
check('14. la salida del BOT respeta el canal: calla en el número tomado y sigue vendiendo por el otro',
  (await outsDelBot(PNID_B)) === outsB13 && (await outsDelBot(PNID_A)) > outsA13,
  `B ${outsB13}→${await outsDelBot(PNID_B)} · A ${outsA13}→${await outsDelBot(PNID_A)}`);

// SALIDA MANUAL: sale por el número de la conversación que el vendedor está mirando (receivedVia).
const wamidB4 = nuevoWamid('IN-B-PRE-MANUAL');
await postWebhook(inbound(PNID_B, 'me confirmás?', wamidB4));
await esperarEvento(wamidB4);
await waitFor(async () => (await cliente())?.conversation?.receivedVia === PNID_B, 10_000);
await borrarTraza();
const rManualB = await call('conversationSendManualMessage', owner, { tenantId: T, customerId: CUST, text: 'Te confirmo en un rato (dual B)' });
const manualB = (await mensajes()).filter((m) => m.author === 'seller' && m.text === 'Te confirmo en un rato (dual B)');
check('15. la salida MANUAL sale por el número del chat tomado (B), no por el que vende',
  rManualB.result?.ok === true && (await trazaEnvio())?.phoneNumberId === PNID_B &&
  manualB.length === 1 && manualB[0]?.receivedVia === PNID_B,
  `err=${rManualB.err} via=${(await trazaEnvio())?.phoneNumberId}`);

// SALIDA DEL BOT (release) por canal: liberar B no toca a nadie más, y B vuelve a contestar.
const rRelease = await call('chatRelease', owner, { tenantId: T, customerId: CUST });
const outsB16 = await outsDelBot(PNID_B);
const wamidB5 = nuevoWamid('IN-B-LIBRE');
await postWebhook(inbound(PNID_B, 'hola', wamidB5));
const volvioB = await waitFor(async () => (await outsDelBot(PNID_B)) > outsB16);
check('16. `chatRelease` libera SOLO el canal de esa conversación (B): el bot vuelve a hablar por B',
  rRelease.err === null && (await sesion(CANAL_B))?.context?.humanTakeover !== true && volvioB,
  `err=${rRelease.err} volvio=${volvioB}`);

// TAKEOVER DE PANEL sobre el canal del que vende (A), con B libre: simétrico del 13-14.
const wamidA4 = nuevoWamid('IN-A-4');
await postWebhook(inbound(PNID_A, 'hola', wamidA4));
await esperarEvento(wamidA4);
await waitFor(async () => (await cliente())?.conversation?.receivedVia === PNID_A, 10_000);
const rTakeA = await call('chatTakeover', owner, { tenantId: T, customerId: CUST });
const outsA17 = await outsDelBot(PNID_A);
const outsB17 = await outsDelBot(PNID_B);
const wamidA5 = nuevoWamid('IN-A-TOMADO');
await postWebhook(inbound(PNID_A, 'sigo esperando', wamidA5));
await esperarEvento(wamidA5);
const wamidB6 = nuevoWamid('IN-B-2');
await postWebhook(inbound(PNID_B, 'y por acá?', wamidB6));
await waitFor(async () => (await outsDelBot(PNID_B)) > outsB17);
await sleep(2500);
check('17. takeover de PANEL en A: el bot calla en A y sigue por B — un canal jamás usa el takeover del otro',
  rTakeA.err === null && (await sesion('active'))?.context?.humanTakeover === true &&
  (await sesion(CANAL_B))?.context?.humanTakeover !== true &&
  (await outsDelBot(PNID_A)) === outsA17 && (await outsDelBot(PNID_B)) > outsB17,
  `A ${outsA17}→${await outsDelBot(PNID_A)} · B ${outsB17}→${await outsDelBot(PNID_B)}`);

// Se libera A por la misma vía (resumen en A tras su último inbound) para la fase final.
const rReleaseA = await call('chatRelease', owner, { tenantId: T, customerId: CUST });

// ===========================================================================
// 18-19. COMPROBANTES POR CANAL: la espera de pago de A no le da significado a un archivo de B
// ===========================================================================
await db.doc(`tenants/${T}/orders/${ORD_A}`).set({
  id: ORD_A, tenantId: T, customerId: CUST, status: 'PENDING_PAYMENT', sessionKey: 'active',
  items: [{ itemId: 'i1', productId: 'lattafa-yara', productName: 'Yara', unitPrice: 180000, quantity: 1, subtotal: 180000 }],
  totals: { subtotal: 180000, discount: 0, total: 180000, currency: 'PYG' },
  payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null },
  delivery: { deliveryId: null, address: { street: '', houseNumber: '', city: '', neighborhood: '', reference: '', coordinates: null } },
  invoice: { invoiceId: null, number: null }, channel: 'WHATSAPP', sellerId: null, source: 'verify-coexistence-dual', notes: '',
  createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
});
// La espera de pago vive SOLO en el canal A; B queda sin contexto de pago.
await setSesion('active', { state: 'AWAITING_PAYMENT', context: { pendingOrderId: ORD_A } });
await setSesion(CANAL_B);

// Es el PRIMER adjunto del cliente en toda la corrida: la limpieza inicial garantiza colección
// vacía, así que el documento que aparezca es el de este envío.
const wamidImgB = nuevoWamid('IMG-B');
await postWebhook(inboundImagen(PNID_B, `MEDIA-DUAL-B-${RUN}`, wamidImgB));
await esperarEvento(wamidImgB);
await waitFor(async () => (await adjuntosDe()).some((a) => a.ingestState === 'stored'), 15_000);
await sleep(2000); // margen: el gate clasifica DESPUÉS de almacenar
const adjB = (await adjuntosDe())[0];
check('18. un archivo entrado por B NO se evalúa contra la espera de pago de A: queda `generic_media`',
  (await adjuntosDe()).length === 1 && adjB?.ingestState === 'stored' &&
  adjB?.classification?.value === 'generic_media' && adjB?.orderCandidateId === null &&
  ((await orden(ORD_A))?.receiptAttachments?.candidateIds ?? []).length === 0,
  `clase=${adjB?.classification?.value} candidatos=${JSON.stringify((await orden(ORD_A))?.receiptAttachments?.candidateIds ?? [])}`);

const wamidImgA = nuevoWamid('IMG-A');
await postWebhook(inboundImagen(PNID_A, `MEDIA-DUAL-A-${RUN}`, wamidImgA));
await esperarEvento(wamidImgA);
const huboCandidato = await waitFor(async () =>
  ((await orden(ORD_A))?.receiptAttachments?.candidateIds ?? []).length === 1, 15_000);
const sesBTrasImg = await sesion(CANAL_B);
check('19. el MISMO archivo por A SÍ es candidato del pedido de SU canal — y la sesión de B ni se entera',
  huboCandidato && (sesBTrasImg?.context?.pendingOrderId ?? null) === null && sesBTrasImg?.state === 'IDLE',
  `candidato=${huboCandidato} B.state=${sesBTrasImg?.state}`);

// ===========================================================================
// 20. EL NÚMERO ACTUAL SIGUE FUNCIONANDO AL FINAL DE TODO
// ===========================================================================
// El comprobante por A pudo tomar el chat para el vendedor (eso es CORRECTO y de su canal). Para
// el check final se libera A (resumen ya en A por su último inbound) y se pide una respuesta.
await call('chatRelease', owner, { tenantId: T, customerId: CUST });
const outsA20 = await outsDelBot(PNID_A);
const wamidA6 = nuevoWamid('IN-A-FINAL');
await postWebhook(inbound(PNID_A, 'hola', wamidA6));
const vendeAlFinal = await waitFor(async () => (await outsDelBot(PNID_A)) > outsA20);
check('20. después de TODO el programa, el número que vende sigue vendiendo por su canal',
  rReleaseA.err === null && vendeAlFinal && (await trazaEnvio())?.phoneNumberId === PNID_A,
  `releaseA=${rReleaseA.err} vende=${vendeAlFinal} via=${(await trazaEnvio())?.phoneNumberId}`);

// ---------------------------------------------------------------------------
// Restauración COMPLETA (convivencia con el resto de la batería)
// ---------------------------------------------------------------------------
await limpiarFixturesPropios();
await borrarDocs(await db.collection(`tenants/${T}/metaAssets`).get());
await borrarDocs(await db.collection(`tenants/${T}/metaConnections`).get());
await borrarDocs(await db.collection('metaExternalIndex').where('tenantId', '==', T).get());
for (const a of snap.assets) await db.doc(`tenants/${T}/metaAssets/${a.id}`).set(a.data);
for (const c of snap.conns) await db.doc(`tenants/${T}/metaConnections/${c.id}`).set(c.data);
for (const i of snap.idx) await db.doc(`metaExternalIndex/${i.id}`).set(i.data);
if (snap.tenant) await db.doc(`tenants/${T}`).set(snap.tenant);
if (snap.channels) await db.doc(`tenants/${T}/config/channels`).set(snap.channels); else await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
if (snap.agent) await db.doc(`tenants/${T}/config/agent`).set(snap.agent); else await db.doc(`tenants/${T}/config/agent`).delete().catch(() => {});
if (snap.attachmentsCfg) await db.doc(`tenants/${T}/config/attachments`).set(snap.attachmentsCfg); else await db.doc(`tenants/${T}/config/attachments`).delete().catch(() => {});
if (snap.receiptGateCfg) await db.doc(`tenants/${T}/config/receiptGate`).set(snap.receiptGateCfg); else await db.doc(`tenants/${T}/config/receiptGate`).delete().catch(() => {});
if (snap.graphFx) await db.doc('metaTestFixtures/graph').set(snap.graphFx); else await db.doc('metaTestFixtures/graph').delete().catch(() => {});
if (snap.secreto) await db.doc(`secrets/meta-token-${T}`).set(snap.secreto); else await db.doc(`secrets/meta-token-${T}`).delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO COEXISTENCE DUAL (ADR-0017 §2): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
