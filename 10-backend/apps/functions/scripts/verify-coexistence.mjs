/**
 * verify-coexistence.mjs — Coexistence de punta a punta contra el emulador (ADR-0017)
 * ====================================================================================
 * El número REAL de la perfumería entra a VendeYaPy sin apagar nada. Este script ejercita ese
 * camino completo con eventos oficiales SANEADOS (inventados acá; jamás datos de nadie) y afirma,
 * uno por uno, los invariantes que hacen que el onboarding sea seguro sobre un número con clientes
 * vivos adentro:
 *
 *   1-3.  El flujo ESTÁNDAR sigue funcionando igual (sin regresión).
 *   4-9.  FINISH de Coexistence válido: conexión PROPIA `wa_{pnid}`, `metaConnections/main`
 *         PRESERVADO íntegro, y el número nuevo nace MUDO (`automationMode` ausente ⇒ inactive)
 *         y no seleccionado.
 *   10-13. Nonce cruzado (estándar↔coexistence, en las dos direcciones), replay del nonce y
 *         re-envío del MISMO `code`.
 *   14-16. El mismo callback dos veces ⇒ mismo resultado: ni segunda conexión, ni segundo secreto,
 *         ni segunda auditoría.
 *   17-19. Colisión cross-tenant del PNID y guard del número principal: rechazo SIN escribir y con
 *         compensación del secreto (fallo parcial).
 *   20-23. Eventos falsos: `object` desconocido, `change.field` desconocido, `account_update` con
 *         evento inventado y un echo cuyo `from` es el NEGOCIO (jamás abre conversación consigo mismo).
 *   24-27. El gate por número en vivo: `inactive` no deja rastro, `shadow` observa en superficie
 *         propia y no toca la conversación, `live` automatiza.
 *   28-35. DOS PNID, EL MISMO CLIENTE, AISLADOS: sesión, carrito, estado, takeover, vendedor,
 *         cobertura, pedido pendiente y destino de la respuesta.
 *   36-45. El coordinador durable del historial: decisión única, disparo único, chunks duplicados /
 *         desordenados / redelivery, adjuntos del historial, agenda que NO crea clientes,
 *         `declined` (2593109, incluso sin envelope) y `expired`.
 *   46-48. `account_update`: ACCOUNT_OFFBOARDED degrada, ACCOUNT_RECONNECTED no re-otorga, y sin
 *         `phone_number_id` no se degrada a NADIE.
 *   49-51. El camino peligroso NO es alcanzable por la superficie estándar (`connectMeta` /
 *         `startMetaConnect` rechazan `mode: 'coexistence'` sin escribir), y la RECUPERACIÓN de un
 *         número degradado por Meta lo devuelve a hablar de verdad (asset **e índice**).
 *
 * NUNCA toca graph.facebook.com: el cliente de Graph del emulador es el fake por fixtures
 * (`metaTestFixtures/graph`). Los tokens son literales de prueba y se verifica que no queden en claro.
 *
 * Requiere: emulador (auth+firestore+functions) con `--project demo-aiafg` + seed-users.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { masRestrictivo } from '@vpw/shared';
// La MISMA herramienta que documenta el runbook (Paso 5 / Paso 11 / Paso 13). Importarla —y no
// reimplementar la escritura— es lo único que hace que este E2E mida la recuperación REAL.
import { migrarModoAutomatizacion } from './migrate-whatsapp-automation-mode.mjs';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';

// ---------------------------------------------------------------------------
// Fixtures con PREFIJO EXCLUSIVO: nada de este script puede colisionar con el de otro.
// ---------------------------------------------------------------------------
const T1 = 'perfumeria';
const T2 = 'boutique-demo';
const WABA = 'WABA-COEX-E2E';
/** El número que HOY vende (conexión heredada `main`, canal `active`). */
const PNID_MAIN = '901900000000001';
/** El número REAL que entra por Coexistence. */
const PNID_COEX = '901900000000002';
/** Números sólo para el coordinador del historial (declinado y vencido). */
const PNID_DECL = '901900000000003';
const PNID_EXP = '901900000000004';
const TODOS_LOS_PNID = [PNID_MAIN, PNID_COEX, PNID_DECL, PNID_EXP];
/** Tokens LITERALES de prueba: se verifica que no queden en claro en ningún documento. */
const TOKEN_STD = 'tok-coex-e2e-STD-NUNCA-persistir';
const TOKEN_COEX = 'tok-coex-e2e-REAL-NUNCA-persistir';
/** El MISMO cliente le escribe a los dos números. Ese es el punto del aislamiento. */
const CUST = '595994100001';
/** wa_id del NEGOCIO: aparece como `from` de un echo y jamás puede volverse un cliente. */
const WAID_NEGOCIO = '595994199999';
/** Contacto de la agenda del vendedor: nunca escribió, así que no puede nacer como cliente. */
const CONTACTO_AGENDA = '595994100777';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, maxMs = 15_000) => {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { if (await pred()) return true; await sleep(600); }
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

/** POST al webhook real. En emulador la firma no se exige (la demo entra por esta misma puerta). */
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
const nuevoWamid = (marca) => `wamid.COEX-${marca}-${Date.now()}-${++wamidSeq}`;

const inbound = (pnid, from, texto, wamid) => sobre(pnid, 'messages', {
  contacts: [{ wa_id: from, profile: { name: 'Cliente Coex' } }],
  messages: [{ from, id: wamid ?? nuevoWamid('IN'), timestamp: '1716750000', type: 'text', text: { body: texto } }],
});

/**
 * ECHO OFICIAL (`smb_message_echoes`): el array es `message_echoes` y cada item trae `from` Y `to`,
 * donde **`from` es el número del NEGOCIO**. Se manda tal cual lo documenta Meta justamente para
 * verificar que el sistema NO lo transporte.
 */
const echo = (pnid, aCliente, texto, wamid, extra = {}) => sobre(pnid, 'smb_message_echoes', {
  message_echoes: [{
    from: WAID_NEGOCIO, to: aCliente, id: wamid ?? nuevoWamid('ECHO'),
    timestamp: '1716750100', type: 'text', text: { body: texto }, ...extra,
  }],
});

const chunkHistorial = (pnid, { phase, chunkOrder, progress, hilos = [], errors = [] }) => sobre(pnid, 'history', {
  history: [{ metadata: { phase, chunk_order: chunkOrder, progress }, threads: hilos, ...(errors.length ? { errors } : {}) }],
});

const docsDe = async (col, campo, valor) => (await db.collection(col).where(campo, '==', valor).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const borrarDocs = async (snap) => { for (const d of snap.docs) await d.ref.delete().catch(() => {}); };
const sesion = async (t, c, key) => (await db.doc(`tenants/${t}/customers/${c}/sessions/${key}`).get()).data();
const mensajes = async (t, c) => (await db.collection(`tenants/${t}/customers/${c}/messages`).get()).docs.map((d) => d.data());
const trazaEnvio = async (t) => (await db.doc(`tenants/${t}/_debug/lastWhatsappSend`).get()).data() ?? null;
const conexion = async (t, id) => (await db.doc(`tenants/${t}/metaConnections/${id}`).get()).data() ?? null;
const asset = async (t, pnid) => (await db.doc(`tenants/${t}/metaAssets/${pnid}`).get()).data() ?? null;
const indice = async (pnid) => (await db.doc(`metaExternalIndex/whatsapp_${pnid}`).get()).data() ?? null;
const coordinador = async (t, pnid) => (await db.doc(`tenants/${t}/coexistenceHistorySyncs/${pnid}`).get()).data() ?? null;
const secretoExiste = async (name) => (await db.doc(`secrets/${name}`).get()).exists;
const eventosDe = async (pnid) => (await db.collection('metaWebhookInbox').where('externalId', '==', pnid).get()).docs
  .map((d) => d.data()).sort((a, b) => (a.receivedAt?.toMillis?.() ?? 0) - (b.receivedAt?.toMillis?.() ?? 0));
const auditoriasDe = async (t, pnid) => (await db.collection(`tenants/${t}/auditLogs`).where('targetId', '==', pnid).get()).docs.map((d) => d.data());

/** El fixture GLOBAL de Graph: decide qué números "tiene" el WABA en cada tramo del script. */
const fixtureGraph = async (phoneNumbers, extra = {}) => db.doc('metaTestFixtures/graph').set({
  accessToken: extra.accessToken ?? TOKEN_STD,
  isValid: true,
  scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
  wabaIds: [WABA],
  tokenExpiresAtMs: null,
  phoneNumbers,
  ...(extra.smbAppDataError ? { smbAppDataError: extra.smbAppDataError } : {}),
});
const telefono = (id, display) => ({ id, displayPhoneNumber: display, verifiedName: 'Coex E2E', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' });

// ---------------------------------------------------------------------------
// SNAPSHOT: este script reescribe conexiones, assets e índice de dos empresas. Todo vuelve.
// ---------------------------------------------------------------------------
const snap = { tenants: {}, assets: {}, conns: {}, idx: [], channels: null, agent: null, graphFx: null, secrets: {} };
for (const t of [T1, T2]) {
  snap.secrets[`meta-token-${t}`] = (await db.doc(`secrets/meta-token-${t}`).get()).data() ?? null;
  snap.tenants[t] = (await db.doc(`tenants/${t}`).get()).data() ?? null;
  snap.assets[t] = (await db.collection(`tenants/${t}/metaAssets`).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
  snap.conns[t] = (await db.collection(`tenants/${t}/metaConnections`).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
  snap.idx.push(...(await db.collection('metaExternalIndex').where('tenantId', '==', t).get()).docs.map((d) => ({ id: d.id, data: d.data() })));
}
snap.channels = (await db.doc(`tenants/${T1}/config/channels`).get()).data() ?? null;
snap.agent = (await db.doc(`tenants/${T1}/config/agent`).get()).data() ?? null;
snap.graphFx = (await db.doc('metaTestFixtures/graph').get()).data() ?? null;

/** Borra TODO lo que este script pudo dejar. Se llama al empezar (re-ejecutable) y al terminar. */
async function limpiarFixturesPropios() {
  for (const t of [T1, T2]) {
    for (const pnid of TODOS_LOS_PNID) {
      await db.doc(`tenants/${t}/metaAssets/${pnid}`).delete().catch(() => {});
      await db.doc(`tenants/${t}/metaConnections/wa_${pnid}`).delete().catch(() => {});
      await db.doc(`tenants/${t}/coexistenceHistorySyncs/${pnid}`).delete().catch(() => {});
      await db.doc(`secrets/meta-token-${t}-${pnid}`).delete().catch(() => {});
    }
    for (const c of [CUST, WAID_NEGOCIO, CONTACTO_AGENDA]) {
      await borrarDocs(await db.collection(`tenants/${t}/customers/${c}/messages`).get());
      await borrarDocs(await db.collection(`tenants/${t}/customers/${c}/sessions`).get());
      await db.doc(`tenants/${t}/customers/${c}`).delete().catch(() => {});
    }
    await db.doc(`tenants/${t}/_debug/lastWhatsappSend`).delete().catch(() => {});
    // Las auditorías son append-only y sobreviven a la corrida: sin barrer las PROPIAS, un check
    // que cuente altas estaría midiendo la historia del emulador y no lo que hizo este script.
    await borrarDocs(await db.collection(`tenants/${t}/auditLogs`).where('targetId', 'in', TODOS_LOS_PNID).get());
  }
  for (const pnid of TODOS_LOS_PNID) {
    await db.doc(`metaExternalIndex/whatsapp_${pnid}`).delete().catch(() => {});
    for (const col of ['metaWebhookInbox', 'metaWebhookHistory', 'metaWebhookAppState']) {
      await borrarDocs(await db.collection(col).where('externalId', '==', pnid).get());
    }
    // La observación de `shadow` se direcciona por `phoneNumberId` (no tiene `externalId`).
    await borrarDocs(await db.collection('metaWebhookShadow').where('phoneNumberId', '==', pnid).get());
  }
  // El secreto del número PRINCIPAL no se borra a ciegas: la conexión restaurada lo sigue
  // referenciando, y dejar un `tokenSecretRef` apuntando a un secreto inexistente deja al tenant
  // «conectado» pero sin poder resolver credenciales — un estado que después confunde a cualquier
  // otro E2E que use ese tenant. Se restaura tal como estaba (ver `snap.secrets`).
  for (const t of [T1, T2]) {
    const previo = snap.secrets[`meta-token-${t}`];
    if (previo) await db.doc(`secrets/meta-token-${t}`).set(previo);
    else await db.doc(`secrets/meta-token-${t}`).delete().catch(() => {});
  }
  await borrarDocs(await db.collection('metaOAuthStates').where('tenantId', 'in', [T1, T2]).get());
}
await limpiarFixturesPropios();

// ---------------------------------------------------------------------------
// PRECONDICIONES. El plan tiene que cubrir varios números; `resolveEntitlements` cachea 30 s en
// memoria, así que el override se escribe UNA vez, al principio, y se espera a que la cache expire.
// Cambiarlo más adelante mediría la cache y no el gate (mismo patrón que verify-fase4-whatsapp).
// ---------------------------------------------------------------------------
for (const t of [T1, T2]) {
  await db.doc(`tenants/${t}`).set({
    planId: 'growth',
    subscription: { status: 'active', currentPeriodStart: Timestamp.now() },
    limitOverrides: { maxWhatsappNumbers: 8 },
    usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() },
  }, { merge: true });
}
// La segunda empresa arranca SIN conexión ni token: así el check del fallo parcial mide la
// compensación de verdad (un secreto preexistente NO se borra a propósito — borrarlo dejaría sin
// credencial a un número que ya estaba conectado). Todo vuelve por el snapshot.
await db.doc(`tenants/${T2}/metaConnections/main`).set({ status: 'not_connected', tokenSecretRef: '', updatedAt: Timestamp.now() }, { merge: true });
await db.doc(`tenants/${T1}/config/channels`).set({ whatsappSendMode: 'live' });
await db.doc(`tenants/${T1}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot de Coexistence' }, { merge: true });
console.log('   (esperando 31s a que expire la cache de entitlements…)');
await sleep(31_000);

const ownerT1 = await signIn('owner@perfumeria.com');
const ownerT2 = await signIn('owner@boutique.com');

// ===========================================================================
// 1-3. EL FLUJO ESTÁNDAR, SIN REGRESIÓN
// ===========================================================================
await fixtureGraph([telefono(PNID_MAIN, '+595 991 900 001')]);
const n1 = await call('startMetaConnect', ownerT1, { tenantId: T1, mode: 'standard' });
const r1 = await call('connectMeta', ownerT1, {
  tenantId: T1, mode: 'standard', nonce: n1.result?.nonce, code: 'code-std-1',
  wabaId: WABA, businessId: 'BIZ-COEX', businessName: 'Perfumería Coex',
});
const connMain = await conexion(T1, 'main');
const assetMain = await asset(T1, PNID_MAIN);
check('1. flujo ESTÁNDAR sin regresión: connectMeta conecta y deja `metaConnections/main` activa',
  r1.result?.ok === true && r1.result?.status === 'active' && r1.result?.phoneNumberId === PNID_MAIN &&
  connMain?.status === 'active' && !!connMain?.tokenSecretRef,
  `err=${r1.err} status=${r1.result?.status} conn=${connMain?.status}`);
check('2. el número principal queda `selected` en la conexión heredada `main` y ruteando por el índice',
  assetMain?.selected === true && assetMain?.connectionId === 'main' && (await indice(PNID_MAIN))?.tenantId === T1,
  `selected=${assetMain?.selected} conn=${assetMain?.connectionId}`);
// ADR-0017 §1: conectar NO autoriza. El principal recibe su `live` por la migración previa al
// deploy (`migrate-whatsapp-automation-mode.mjs`), que es exactamente este merge de UN campo.
check('3. ni el flujo estándar autoriza automatización: el asset nace SIN `automationMode`',
  assetMain?.automationMode === undefined, `automationMode=${assetMain?.automationMode}`);
await db.doc(`tenants/${T1}/metaAssets/${PNID_MAIN}`).set({ automationMode: 'live' }, { merge: true });

/** Foto EXACTA de la conexión que hoy vende: se compara íntegra después del onboarding real. */
const mainAntes = JSON.stringify(await conexion(T1, 'main'));
const assetMainAntes = JSON.stringify(await asset(T1, PNID_MAIN));

// ===========================================================================
// 4-9. FINISH DE COEXISTENCE VÁLIDO
// ===========================================================================
// El WABA lista los DOS números: es el caso real del día del onboarding y el que hace peligroso
// "adivinar el primero". El PNID se resuelve server-side; el pedido explícito desempata.
await fixtureGraph([telefono(PNID_MAIN, '+595 991 900 001'), telefono(PNID_COEX, '+595 991 900 002')], { accessToken: TOKEN_COEX });
const nC = await call('coexistenceStart', ownerT1, { tenantId: T1 });
const rC = await call('coexistenceConnect', ownerT1, {
  tenantId: T1, nonce: nC.result?.nonce, code: 'code-coex-1',
  wabaId: WABA, phoneNumberId: PNID_COEX, businessId: 'BIZ-COEX', businessName: 'Perfumería Coex',
});
const connCoex = await conexion(T1, `wa_${PNID_COEX}`);
const assetCoex = await asset(T1, PNID_COEX);
const idxCoex = await indice(PNID_COEX);
check('4. FINISH de Coexistence válido → conexión PROPIA `wa_{pnid}` (nunca `main`), origen embedded_signup',
  rC.result?.ok === true && rC.result?.connectionId === `wa_${PNID_COEX}` && rC.result?.replay === false &&
  !!connCoex && connCoex.source === 'embedded_signup' && !!connCoex.tokenSecretRef,
  `err=${rC.err} ${rC.msg.slice(0, 80)} conn=${rC.result?.connectionId}`);
check('5. `metaConnections/main` PRESERVADO ÍNTEGRO: el número que vende no se tocó ni un campo',
  JSON.stringify(await conexion(T1, 'main')) === mainAntes && JSON.stringify(await asset(T1, PNID_MAIN)) === assetMainAntes);
check('6. el número nuevo nace MUDO: `automationMode` ausente (⇒ inactive) y `selected: false`',
  assetCoex?.automationMode === undefined && assetCoex?.selected === false && assetCoex?.status === 'active' &&
  rC.result?.automationMode === 'inactive',
  `mode=${assetCoex?.automationMode} selected=${assetCoex?.selected}`);
check('7. estrena su PROPIO canal de conversación (ADR-0017 §2): sessionKey `wa_{pnid}`, no `active`',
  assetCoex?.sessionKey === `wa_${PNID_COEX}` && assetCoex?.connectionId === `wa_${PNID_COEX}`,
  `sessionKey=${assetCoex?.sessionKey}`);
check('8. el índice rutea el número nuevo a SU conexión (no a la del principal)',
  idxCoex?.tenantId === T1 && idxCoex?.connectionId === `wa_${PNID_COEX}` && idxCoex?.status === 'active',
  `conn=${idxCoex?.connectionId}`);
const dumpCoex = JSON.stringify([connCoex, assetCoex, idxCoex, await conexion(T1, 'main')]);
check('9. el token vive en su propio secreto y NO aparece en claro en conexión/asset/índice',
  (await secretoExiste(`meta-token-${T1}-${PNID_COEX}`)) && !dumpCoex.includes(TOKEN_COEX) && !dumpCoex.includes(TOKEN_STD));

// ===========================================================================
// 10-13. NONCE CRUZADO, REPLAY Y RE-ENVÍO DEL MISMO CODE
// ===========================================================================
// ADR-0017 §5: son dos consentimientos distintos del dueño sobre dos actos distintos, y uno de
// ellos escribe sobre la conexión del número que ya vende. Ninguno vale por el otro.
const mainAntesCruce = JSON.stringify(await conexion(T1, 'main'));
const nStd = await call('startMetaConnect', ownerT1, { tenantId: T1, mode: 'standard' });
const rCruce1 = await call('coexistenceConnect', ownerT1, { tenantId: T1, nonce: nStd.result?.nonce, code: 'code-cruce-1', wabaId: WABA, phoneNumberId: PNID_COEX });
check('10. nonce ESTÁNDAR presentado como Coexistence → rechazado, sin escribir nada',
  rCruce1.err === 'FAILED_PRECONDITION' && JSON.stringify(await conexion(T1, 'main')) === mainAntesCruce,
  `err=${rCruce1.err}`);

const nCoex2 = await call('coexistenceStart', ownerT1, { tenantId: T1 });
const rCruce2 = await call('connectMeta', ownerT1, { tenantId: T1, mode: 'standard', nonce: nCoex2.result?.nonce, code: 'code-cruce-2', wabaId: WABA });
check('11. nonce de COEXISTENCE presentado como estándar → rechazado; `main` intacto',
  rCruce2.err === 'FAILED_PRECONDITION' && JSON.stringify(await conexion(T1, 'main')) === mainAntesCruce,
  `err=${rCruce2.err}`);

/**
 * Altas auditadas ANTES del segundo callback. Se mide el DELTA y no el total: `meta.number_added`
 * es la acción que también usan la decisión del historial y el disparo (el hecho auditado es «pasó
 * algo con este número»), así que un total absoluto afirmaría sobre otra cosa.
 */
const altasAntesReplay = (await auditoriasDe(T1, PNID_COEX)).filter((a) => a.action === 'meta.number_added').length;
const nReplay = await call('coexistenceStart', ownerT1, { tenantId: T1 });
const rReplayA = await call('coexistenceConnect', ownerT1, { tenantId: T1, nonce: nReplay.result?.nonce, code: 'code-replay-1', wabaId: WABA, phoneNumberId: PNID_COEX });
const rReplayB = await call('coexistenceConnect', ownerT1, { tenantId: T1, nonce: nReplay.result?.nonce, code: 'code-replay-2', wabaId: WABA, phoneNumberId: PNID_COEX });
check('12. REPLAY del nonce: el primero resuelve, el segundo se rechaza (un solo uso)',
  rReplayA.result?.ok === true && rReplayB.err === 'FAILED_PRECONDITION', `1=${rReplayA.err ?? 'ok'} 2=${rReplayB.err}`);

const nCode = await call('coexistenceStart', ownerT1, { tenantId: T1 });
const rMismoCode = await call('coexistenceConnect', ownerT1, { tenantId: T1, nonce: nCode.result?.nonce, code: 'code-coex-1', wabaId: WABA, phoneNumberId: PNID_COEX });
check('13. el MISMO `code` con un nonce nuevo → rechazado (single-flight del code de Meta)',
  rMismoCode.err === 'FAILED_PRECONDITION', `err=${rMismoCode.err}`);

// ===========================================================================
// 14-16. EL MISMO CALLBACK DOS VECES ⇒ MISMO RESULTADO
// ===========================================================================
// `rReplayA` fue, de hecho, un segundo callback legítimo (nonce y code nuevos) sobre un número YA
// conectado. Tiene que devolver lo mismo y no haber escrito nada nuevo.
const connCoexDespues = await conexion(T1, `wa_${PNID_COEX}`);
check('14. segundo callback → MISMO resultado marcado `replay`, misma conexión, sin segunda conexión',
  rReplayA.result?.replay === true && rReplayA.result?.connectionId === `wa_${PNID_COEX}` &&
  connCoexDespues?.createdAt?.toMillis?.() === connCoex?.createdAt?.toMillis?.(),
  `replay=${rReplayA.result?.replay}`);
check('15. sin SEGUNDO secreto: la referencia del token es exactamente la misma',
  connCoexDespues?.tokenSecretRef === connCoex?.tokenSecretRef,
  `${connCoexDespues?.tokenSecretRef === connCoex?.tokenSecretRef}`);
const altasDespuesReplay = (await auditoriasDe(T1, PNID_COEX)).filter((a) => a.action === 'meta.number_added').length;
check('16. sin segunda auditoría de alta para ese número (un replay no es un alta)',
  altasAntesReplay >= 1 && altasDespuesReplay === altasAntesReplay,
  `altas ${altasAntesReplay}→${altasDespuesReplay}`);

// ===========================================================================
// 17-19. COLISIÓN CROSS-TENANT, GUARD DEL PRINCIPAL Y FALLO PARCIAL CON COMPENSACIÓN
// ===========================================================================
const nT2 = await call('coexistenceStart', ownerT2, { tenantId: T2 });
const rColision = await call('coexistenceConnect', ownerT2, { tenantId: T2, nonce: nT2.result?.nonce, code: 'code-t2-colision', wabaId: WABA, phoneNumberId: PNID_COEX });
check('17. colisión cross-tenant: otra empresa NO puede reclamar un PNID ya conectado, y el ruteo del dueño no cambia',
  rColision.err === 'FAILED_PRECONDITION' && rColision.msg.includes('otra empresa') &&
  !(await secretoExiste(`meta-token-${T2}-${PNID_COEX}`)) && (await asset(T2, PNID_COEX)) === null &&
  (await conexion(T2, `wa_${PNID_COEX}`)) === null && (await indice(PNID_COEX))?.tenantId === T1,
  `err=${rColision.err} msg=${rColision.msg.slice(0, 60)}`);

const nPrincipal = await call('coexistenceStart', ownerT1, { tenantId: T1 });
const rPrincipal = await call('coexistenceConnect', ownerT1, { tenantId: T1, nonce: nPrincipal.result?.nonce, code: 'code-principal', wabaId: WABA, phoneNumberId: PNID_MAIN });
check('18. el número PRINCIPAL no se conecta por Coexistence: rechazo sin tocar su asset ni crear secreto',
  rPrincipal.err === 'FAILED_PRECONDITION' && JSON.stringify(await asset(T1, PNID_MAIN)) === assetMainAntes &&
  !(await secretoExiste(`meta-token-${T1}-${PNID_MAIN}`)) && (await conexion(T1, `wa_${PNID_MAIN}`)) === null,
  `err=${rPrincipal.err}`);

/**
 * FALLO PARCIAL DE VERDAD. El alta de Coexistence corta en el chequeo temprano de colisión, o sea
 * ANTES de guardar un token: no hay nada que compensar. El camino que SÍ deja un secreto huérfano
 * es el estándar — guarda el token y recién después escribe assets e índice, y ahí el guard
 * transaccional de propiedad del PNID puede rechazar. Es el escenario que este check ejercita:
 * otra empresa intenta el Embedded Signup estándar sobre el número que ya conectó la primera.
 */
await fixtureGraph([telefono(PNID_COEX, '+595 991 900 002')], { accessToken: TOKEN_COEX });
const idxAntesParcial = JSON.stringify(await indice(PNID_COEX));
const nT2b = await call('startMetaConnect', ownerT2, { tenantId: T2, mode: 'standard' });
const rParcial = await call('connectMeta', ownerT2, { tenantId: T2, mode: 'standard', nonce: nT2b.result?.nonce, code: 'code-t2-parcial', wabaId: WABA });
check('19. fallo PARCIAL del alta estándar sobre un PNID ajeno → rechazo, secreto COMPENSADO y cero escrituras',
  rParcial.err === 'FAILED_PRECONDITION' && rParcial.msg.includes('otra empresa') &&
  !(await secretoExiste(`meta-token-${T2}`)) && (await asset(T2, PNID_COEX)) === null &&
  (await conexion(T2, 'main'))?.status !== 'active' && JSON.stringify(await indice(PNID_COEX)) === idxAntesParcial,
  `err=${rParcial.err} msg=${rParcial.msg.slice(0, 60)}`);

// ===========================================================================
// 20-23. EVENTOS Y ORIGEN FALSOS
// ===========================================================================
const inboxAntesFalsos = (await db.collection('metaWebhookInbox').get()).size;
const rObjFalso = await postWebhook({ object: 'no_es_un_objeto_de_meta', entry: [{ id: WABA, changes: [{ field: 'messages', value: { metadata: { phone_number_id: PNID_COEX }, messages: [{ from: CUST, id: nuevoWamid('FAKE'), type: 'text', text: { body: 'inyectado' } }] } }] }] });
check('20. `object` desconocido → ACK sin escribir NADA (ni un evento en la bandeja)',
  rObjFalso.status === 200 && rObjFalso.body?.written === 0 && (await db.collection('metaWebhookInbox').get()).size === inboxAntesFalsos,
  `written=${rObjFalso.body?.written}`);

const rCampoFalso = await postWebhook(sobre(PNID_COEX, 'campo_inventado_por_un_tercero', { campo_inventado_por_un_tercero: [{ a: 1 }, { b: 2 }] }));
check('21. `change.field` desconocido → auditado como forma, cero escrituras, cero automatización',
  rCampoFalso.status === 200 && rCampoFalso.body?.written === 0 && rCampoFalso.body?.unknownFields === 1 &&
  (await docsDe('metaWebhookHistory', 'externalId', PNID_COEX)).length === 0,
  `unknown=${rCampoFalso.body?.unknownFields} written=${rCampoFalso.body?.written}`);

const modoAntesEventoRaro = (await asset(T1, PNID_COEX))?.automationMode;
const rEventoRaro = await postWebhook(sobre(PNID_COEX, 'account_update', { event: 'EVENTO_QUE_NO_EXISTE' }));
check('22. `account_update` con evento inventado → sin efecto sobre el permiso del número',
  rEventoRaro.status === 200 && (await asset(T1, PNID_COEX))?.automationMode === modoAntesEventoRaro);

// El echo trae `from` = NEGOCIO. Se manda con el número todavía MUDO: ni observado debe crear un
// cliente con el wa_id de la propia perfumería.
await postWebhook(echo(PNID_COEX, CUST, 'hola, te contesto desde el celu', nuevoWamid('ECHO-FALSO')));
await sleep(2500);
check('23. el `from` de un echo (el NEGOCIO) jamás se transporta: no nace un cliente con ese wa_id',
  !(await db.doc(`tenants/${T1}/customers/${WAID_NEGOCIO}`).get()).exists &&
  (await eventosDe(PNID_COEX)).every((e) => e.payload?.from === undefined));

// ===========================================================================
// 24-27. EL GATE POR NÚMERO, EN VIVO
// ===========================================================================
await db.doc(`tenants/${T1}/_debug/lastWhatsappSend`).delete().catch(() => {});
await postWebhook(inbound(PNID_COEX, CUST, 'hola, sigo con el número nuevo?'));
await sleep(4000);
const evInactive = (await eventosDe(PNID_COEX)).filter((e) => e.kind === 'message').pop();
check('24. `inactive`: ACK y nada más — evento cerrado con el motivo, sin mensajes ni envío',
  evInactive?.processingStatus === 'ignored' && evInactive?.automationMode === 'inactive' &&
  (await mensajes(T1, CUST)).length === 0 && (await trazaEnvio(T1)) === null,
  `status=${evInactive?.processingStatus} mode=${evInactive?.automationMode}`);

await db.doc(`tenants/${T1}/metaAssets/${PNID_COEX}`).set({ automationMode: 'shadow' }, { merge: true });
const wamidShadow = nuevoWamid('SHADOW');
await postWebhook(inbound(PNID_COEX, CUST, 'esto se mira, no se contesta', wamidShadow));
const huboSombra = await waitFor(async () => (await docsDe('metaWebhookShadow', 'phoneNumberId', PNID_COEX)).length > 0, 12_000);
const sombra = (await docsDe('metaWebhookShadow', 'phoneNumberId', PNID_COEX))[0];
check('25. `shadow`: se observa en superficie PROPIA, marcada inerte y con el canal del número',
  huboSombra && sombra?.tenantId === T1 && sombra?.automationEligible === false && sombra?.unread === false &&
  sombra?.sessionKey === `wa_${PNID_COEX}`,
  `obs=${huboSombra} sessionKey=${sombra?.sessionKey}`);
check('26. `shadow` NO toca la conversación del cliente: ni mensajes, ni resumen, ni envío',
  (await mensajes(T1, CUST)).length === 0 && !(await db.doc(`tenants/${T1}/customers/${CUST}`).get()).exists &&
  (await trazaEnvio(T1)) === null);

await db.doc(`tenants/${T1}/metaAssets/${PNID_COEX}`).set({ automationMode: 'live' }, { merge: true });
await postWebhook(inbound(PNID_COEX, CUST, 'hola'));
const contestoCoex = await waitFor(async () => (await mensajes(T1, CUST)).some((m) => m.direction === 'out' && m.receivedVia === PNID_COEX), 20_000);
check('27. `live`: recién ahí el bot contesta, y lo hace por el número que recibió',
  contestoCoex && (await trazaEnvio(T1))?.phoneNumberId === PNID_COEX,
  `contesto=${contestoCoex} via=${(await trazaEnvio(T1))?.phoneNumberId}`);

// ===========================================================================
// 28-35. DOS PNID, EL MISMO CLIENTE, TOTALMENTE AISLADOS
// ===========================================================================
await db.doc(`tenants/${T1}/_debug/lastWhatsappSend`).delete().catch(() => {});
await postWebhook(inbound(PNID_MAIN, CUST, 'hola'));
const contestoMain = await waitFor(async () => (await mensajes(T1, CUST)).some((m) => m.direction === 'out' && m.receivedVia === PNID_MAIN), 20_000);
check('28. el MISMO cliente por el otro número: el bot contesta por el número heredado',
  contestoMain && (await trazaEnvio(T1))?.phoneNumberId === PNID_MAIN,
  `contesto=${contestoMain} via=${(await trazaEnvio(T1))?.phoneNumberId}`);

const sesLegacy = await sesion(T1, CUST, 'active');
const sesCoex = await sesion(T1, CUST, `wa_${PNID_COEX}`);
check('29. DOS conversaciones separadas: cada número tiene su propio documento de sesión, y cada uno dice cuál es',
  sesLegacy?.id === 'active' && sesCoex?.id === `wa_${PNID_COEX}`,
  `legacy=${sesLegacy?.id} coex=${sesCoex?.id}`);

// El vendedor contesta DESDE SU TELÉFONO por el número real: echo → takeover de ESE canal.
const wamidEcho = nuevoWamid('ECHO-LIVE');
await postWebhook(echo(PNID_COEX, CUST, 'Hola! te escribo yo desde el celular', wamidEcho));
const takeoverCoex = await waitFor(async () => (await sesion(T1, CUST, `wa_${PNID_COEX}`))?.context?.humanTakeover === true, 15_000);
const legacyTrasEcho = await sesion(T1, CUST, 'active');
check('30. el echo activa el TAKEOVER del canal del número real y NO el del número que vende',
  takeoverCoex && legacyTrasEcho?.context?.humanTakeover !== true,
  `coex=${takeoverCoex} legacy=${legacyTrasEcho?.context?.humanTakeover}`);
const msgsEcho = (await mensajes(T1, CUST)).filter((m) => m.origin === 'whatsapp_business_app');
check('31. el echo se persiste como outbound HUMANO del número real, con vendedor y canal propios',
  msgsEcho.length === 1 && msgsEcho[0].direction === 'out' && msgsEcho[0].author === 'seller' && msgsEcho[0].receivedVia === PNID_COEX &&
  (await sesion(T1, CUST, `wa_${PNID_COEX}`))?.context?.handoffReason === 'seller_manual' &&
  (legacyTrasEcho?.context?.handoffReason ?? null) === null,
  `n=${msgsEcho.length} via=${msgsEcho[0]?.receivedVia}`);

// Con el vendedor atendiendo el número real, el bot tiene que seguir vendiendo por el otro.
const outsMainAntes = (await mensajes(T1, CUST)).filter((m) => m.direction === 'out' && m.receivedVia === PNID_MAIN).length;
const outsCoexAntes = (await mensajes(T1, CUST)).filter((m) => m.direction === 'out' && m.author === 'bot' && m.receivedVia === PNID_COEX).length;
await postWebhook(inbound(PNID_COEX, CUST, 'seguís ahí?'));
await postWebhook(inbound(PNID_MAIN, CUST, 'hola'));
await waitFor(async () => (await mensajes(T1, CUST)).filter((m) => m.direction === 'out' && m.receivedVia === PNID_MAIN).length > outsMainAntes, 20_000);
await sleep(3000);
const outsMainDespues = (await mensajes(T1, CUST)).filter((m) => m.direction === 'out' && m.receivedVia === PNID_MAIN).length;
const outsCoexDespues = (await mensajes(T1, CUST)).filter((m) => m.direction === 'out' && m.author === 'bot' && m.receivedVia === PNID_COEX).length;
check('32. takeover AISLADO de punta a punta: el bot calla en el número tomado y sigue vendiendo en el otro',
  outsCoexDespues === outsCoexAntes && outsMainDespues > outsMainAntes,
  `coex ${outsCoexAntes}→${outsCoexDespues} · main ${outsMainAntes}→${outsMainDespues}`);

/**
 * ESTADO COMERCIAL DEL CANAL QUE VENDE, sembrado a mano y a propósito: un checkout en curso, un
 * carrito, un pedido pendiente, una oferta esperando confirmación y el puntero de Coverage. Es el
 * estado que el ADR §2 declara POR CANAL, y sembrarlo es la única forma de comprobar que un turno
 * del número nuevo ni lo lee ni lo pisa. Va DESPUÉS de las afirmaciones sobre respuestas del bot:
 * un `AWAITING_PAYMENT` cambia lo que el motor contesta, y acá el sujeto es el aislamiento.
 */
await db.doc(`tenants/${T1}/customers/${CUST}/sessions/active`).set({
  state: 'AWAITING_PAYMENT',
  cart: { items: [{ sku: 'COEX-SKU-1', name: 'Perfume de prueba', qty: 2, unitPrice: 100_000 }], total: 200_000 },
  context: {
    pendingOrderId: 'ord-legacy-coex-e2e',
    pendingCartConfirmation: { sku: 'COEX-SKU-1', qty: 1 },
    coverage: { requestId: 'cov-legacy-coex-e2e', status: 'awaiting_location' },
  },
  updatedAt: Timestamp.now(),
}, { merge: true });

await postWebhook(inbound(PNID_COEX, CUST, 'quiero ver el catálogo'));
await sleep(6000);
const legacyDespues = await sesion(T1, CUST, 'active');
const coexDespues = await sesion(T1, CUST, `wa_${PNID_COEX}`);
check('33. carrito y estado AISLADOS: el turno del número nuevo no ve ni pisa el checkout del que vende',
  legacyDespues?.state === 'AWAITING_PAYMENT' && legacyDespues?.cart?.items?.length === 1 &&
  (coexDespues?.cart?.items?.length ?? 0) === 0 && coexDespues?.state !== 'AWAITING_PAYMENT',
  `legacy=${legacyDespues?.state}/${legacyDespues?.cart?.items?.length} coex=${coexDespues?.state}/${coexDespues?.cart?.items?.length ?? 0}`);
check('34. pedido pendiente y puntero de COBERTURA aislados: viven sólo en el canal que los creó',
  legacyDespues?.context?.pendingOrderId === 'ord-legacy-coex-e2e' &&
  legacyDespues?.context?.coverage?.requestId === 'cov-legacy-coex-e2e' &&
  (coexDespues?.context?.pendingOrderId ?? null) === null && (coexDespues?.context?.coverage ?? null) === null,
  `coex.pendingOrderId=${coexDespues?.context?.pendingOrderId} coex.coverage=${JSON.stringify(coexDespues?.context?.coverage ?? null)}`);
check('35. la oferta de carrito pendiente del canal heredado sobrevive intacta al turno del otro número',
  legacyDespues?.context?.pendingCartConfirmation?.sku === 'COEX-SKU-1',
  `pending=${JSON.stringify(legacyDespues?.context?.pendingCartConfirmation ?? null)}`);

// ===========================================================================
// 36-45. EL COORDINADOR DURABLE DEL HISTORIAL
// ===========================================================================
const rDecision = await call('coexistenceDecideHistorySharing', ownerT1, { tenantId: T1, phoneNumberId: PNID_COEX, decision: 'share' });
const rDecision2 = await call('coexistenceDecideHistorySharing', ownerT1, { tenantId: T1, phoneNumberId: PNID_COEX, decision: 'skip' });
check('36. la decisión sobre el historial es HUMANA y de UNA sola vez (la segunda se rechaza)',
  rDecision.result?.ok === true && rDecision.result?.status === 'pending_request' && rDecision2.err === 'FAILED_PRECONDITION',
  `1=${rDecision.result?.status} 2=${rDecision2.err}`);

const rDisparo = await call('coexistenceRequestHistorySync', ownerT1, { tenantId: T1, phoneNumberId: PNID_COEX });
const rDisparo2 = await call('coexistenceRequestHistorySync', ownerT1, { tenantId: T1, phoneNumberId: PNID_COEX });
check('37. el disparo pide los DOS sync_type en orden y se puede usar UNA sola vez',
  rDisparo.result?.ok === true && JSON.stringify(rDisparo.result?.syncTypes) === JSON.stringify(['smb_app_state_sync', 'history']) &&
  rDisparo2.err === 'FAILED_PRECONDITION' && rDisparo2.msg.includes('UNA sola vez'),
  `1=${JSON.stringify(rDisparo.result?.syncTypes)} 2=${rDisparo2.err}`);

const hiloHistorial = (n) => [{ id: CUST, messages: [
  { id: `wamid.HIST-${n}-a`, from: CUST, type: 'text', text: { body: `mensaje viejo ${n}` }, timestamp: '1700000000', history_context: { status: 'READ' } },
  { id: `wamid.HIST-${n}-b`, from: WAID_NEGOCIO, type: 'text', text: { body: `respuesta vieja ${n}` }, timestamp: '1700000100', history_context: { status: 'DELIVERED' } },
] }];
// DESORDENADO a propósito (chunk 2 antes que el 1) y con REDELIVERY del 1: es exactamente lo que
// hace Meta cuando el webhook no responde 200 a tiempo.
await postWebhook(chunkHistorial(PNID_COEX, { phase: 0, chunkOrder: 2, progress: 60, hilos: hiloHistorial(2) }));
await postWebhook(chunkHistorial(PNID_COEX, { phase: 0, chunkOrder: 1, progress: 30, hilos: hiloHistorial(1) }));
const rDup = await postWebhook(chunkHistorial(PNID_COEX, { phase: 0, chunkOrder: 1, progress: 30, hilos: hiloHistorial(1) }));
await sleep(1500);
const coordHist = await coordinador(T1, PNID_COEX);
check('38. chunks DESORDENADOS: el progreso es el MÁXIMO visto, no el último que llegó',
  coordHist?.maxProgress === 60, `maxProgress=${coordHist?.maxProgress}`);
check('39. chunk DUPLICADO (redelivery): se cuenta como duplicado, no crea un segundo documento',
  rDup.body?.historyDuplicates === 1 && coordHist?.chunksDuplicados === 1 && coordHist?.chunksObservadosCount === 2 &&
  (await docsDe('metaWebhookHistory', 'externalId', PNID_COEX)).filter((d) => d.eventType === 'history').length === 2,
  `dups=${coordHist?.chunksDuplicados} count=${coordHist?.chunksObservadosCount}`);
const docsHist = await docsDe('metaWebhookHistory', 'externalId', PNID_COEX);
check('40. el historial va a su colección CERRADA, inerte y con empresa resuelta — nunca a la bandeja',
  docsHist.length > 0 && docsHist.every((d) => d.historical === true && d.automationEligible === false && d.unread === false && d.tenantId === T1) &&
  (await eventosDe(PNID_COEX)).every((e) => e.kind !== 'history'),
  `docs=${docsHist.length}`);

// Los IDs de los ADJUNTOS del historial llegan con `field: "history"` pero en `value.messages[]`.
await postWebhook(sobre(PNID_COEX, 'history', { messages: [{ id: 'wamid.HIST-MEDIA-1', type: 'image', timestamp: '1700000200', image: { id: 'media-coex-e2e-1', mime_type: 'image/jpeg', sha256: 'abc' } }] }));
await sleep(1500);
check('41. los adjuntos del historial (`history` con `messages[]`) se rescatan al mismo archivo cerrado',
  (await docsDe('metaWebhookHistory', 'externalId', PNID_COEX)).some((d) => d.eventType === 'history_media' && d.payload?.historyMedia?.mediaId === 'media-coex-e2e-1') &&
  ((await coordinador(T1, PNID_COEX))?.mediaObservados ?? 0) >= 1);

await postWebhook(sobre(PNID_COEX, 'smb_app_state_sync', { state_sync: [{ type: 'contact', action: 'add', contact: { phone_number: CONTACTO_AGENDA, full_name: 'Contacto Agenda', first_name: 'Contacto' }, metadata: { timestamp: '1700000300' } }] }));
await sleep(1500);
check('42. la agenda del vendedor va a su colección propia y NO fabrica clientes',
  (await docsDe('metaWebhookAppState', 'externalId', PNID_COEX)).length === 1 &&
  !(await db.doc(`tenants/${T1}/customers/${CONTACTO_AGENDA}`).get()).exists);

await postWebhook(chunkHistorial(PNID_COEX, { phase: 1, chunkOrder: 1, progress: 100, hilos: hiloHistorial(3) }));
await sleep(1500);
const rEstado = await call('coexistenceSyncStatus', ownerT1, { tenantId: T1, phoneNumberId: PNID_COEX });
check('43. con el 100 % y sin fallos pendientes, la sincronización se declara COMPLETA',
  rEstado.result?.status === 'completed' && rEstado.result?.progress === 100 && rEstado.result?.chunksPendientes === 0 &&
  rEstado.result?.chunksSinTenant === 0,
  `status=${rEstado.result?.status} progress=${rEstado.result?.progress}`);

// --- DECLINED (2593109) sobre un número aparte: es un desenlace terminal. Y llega SIN envelope. ---
await sembrarNumeroDeArchivo(PNID_DECL, Date.now());
await call('coexistenceDecideHistorySharing', ownerT1, { tenantId: T1, phoneNumberId: PNID_DECL, decision: 'share' });
await postWebhook({ value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID_DECL }, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 0 }, threads: [], errors: [{ code: 2593109, title: 'Business did not share history' }] }] } });
await sleep(1500);
const rDeclinado = await call('coexistenceSyncStatus', ownerT1, { tenantId: T1, phoneNumberId: PNID_DECL });
check('44. «el negocio no compartió» (2593109) se lee AUNQUE llegue sin envelope → estado `declined`',
  rDeclinado.result?.status === 'declined' && rDeclinado.result?.declineCode === 2593109,
  `status=${rDeclinado.result?.status} code=${rDeclinado.result?.declineCode}`);

// --- EXPIRED: la ventana de 24 h corre desde el ONBOARDING, no desde el disparo. ---
await sembrarNumeroDeArchivo(PNID_EXP, Date.now() - 48 * 3_600_000);
const rDecExp = await call('coexistenceDecideHistorySharing', ownerT1, { tenantId: T1, phoneNumberId: PNID_EXP, decision: 'share' });
const rDispExp = await call('coexistenceRequestHistorySync', ownerT1, { tenantId: T1, phoneNumberId: PNID_EXP });
const rEstadoExp = await call('coexistenceSyncStatus', ownerT1, { tenantId: T1, phoneNumberId: PNID_EXP });
check('45. ventana VENCIDA: el disparo se rechaza explicando por qué y el coordinador queda `expired`',
  rDecExp.result?.ok === true && rDispExp.err === 'FAILED_PRECONDITION' && rDispExp.msg.includes('24 h') &&
  rEstadoExp.result?.status === 'expired',
  `disparo=${rDispExp.err} estado=${rEstadoExp.result?.status}`);

// ===========================================================================
// 46-48. META DESCONECTA EL NÚMERO SOLO (account_update)
// ===========================================================================
const assetAntesOff = await asset(T1, PNID_COEX);
await postWebhook(sobre(PNID_COEX, 'account_update', { event: 'ACCOUNT_OFFBOARDED', timestamp: 1716750200 }));
await sleep(1500);
const assetOff = await asset(T1, PNID_COEX);
check('46. ACCOUNT_OFFBOARDED degrada el permiso a `inactive` en asset e índice',
  assetOff?.automationMode === 'inactive' && (await indice(PNID_COEX))?.automationMode === 'inactive' &&
  assetOff?.coexistenceLastAccountEvent === 'ACCOUNT_OFFBOARDED',
  `mode=${assetOff?.automationMode} idx=${(await indice(PNID_COEX))?.automationMode}`);
check('47. y NO toca nada más: status, selected, canal y conexión quedan como estaban',
  assetOff?.status === assetAntesOff?.status && assetOff?.selected === assetAntesOff?.selected &&
  assetOff?.sessionKey === assetAntesOff?.sessionKey && assetOff?.connectionId === assetAntesOff?.connectionId &&
  !!(await conexion(T1, `wa_${PNID_COEX}`))?.tokenSecretRef);

await postWebhook(sobre(PNID_COEX, 'account_update', { event: 'ACCOUNT_RECONNECTED', timestamp: 1716750300 }));
const modoMainAntesSinPnid = (await asset(T1, PNID_MAIN))?.automationMode;
await postWebhook({ object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'account_update', value: { event: 'ACCOUNT_OFFBOARDED' } }] }] });
await sleep(1500);
check('48. reconectar NO re-otorga permiso, y un evento SIN phone_number_id no degrada a nadie',
  (await asset(T1, PNID_COEX))?.automationMode === 'inactive' &&
  (await asset(T1, PNID_MAIN))?.automationMode === modoMainAntesSinPnid && modoMainAntesSinPnid === 'live',
  `coex=${(await asset(T1, PNID_COEX))?.automationMode} main=${(await asset(T1, PNID_MAIN))?.automationMode}`);

// ===========================================================================
// 49-51. EL CAMINO PELIGROSO NO ES ALCANZABLE, Y LA RECUPERACIÓN RECUPERA DE VERDAD
// ===========================================================================
/**
 * 49-50. `connectMeta` corre `runMetaConnect`: guarda el token en el secreto del TENANT (pisando
 * el de `main`) y reescribe `metaAssets` con `connectionId: 'main'`, cuya limpieza BORRA el asset
 * y la entrada de índice del número que hoy vende. El botón de Coexistence del panel usaba ese
 * callable con `mode: 'coexistence'`. Ahora el panel usa `coexistence*` y esta superficie rechaza
 * ese modo: defensa en profundidad, y el rechazo ocurre ANTES de consumir el nonce.
 */
const mainAntesModo = JSON.stringify(await conexion(T1, 'main'));
const assetMainAntesModo = JSON.stringify(await asset(T1, PNID_MAIN));
const idxMainAntesModo = JSON.stringify(await indice(PNID_MAIN));
const nModo = await call('coexistenceStart', ownerT1, { tenantId: T1 });
const rModo = await call('connectMeta', ownerT1, { tenantId: T1, mode: 'coexistence', nonce: nModo.result?.nonce, code: 'code-modo-peligroso', wabaId: WABA });
check('49. `connectMeta` con `mode:"coexistence"` se RECHAZA: el camino que reescribe `main` no es alcanzable',
  rModo.err === 'INVALID_ARGUMENT' &&
  JSON.stringify(await conexion(T1, 'main')) === mainAntesModo &&
  JSON.stringify(await asset(T1, PNID_MAIN)) === assetMainAntesModo &&
  JSON.stringify(await indice(PNID_MAIN)) === idxMainAntesModo,
  `err=${rModo.err} msg=${rModo.msg.slice(0, 60)}`);

const rModoStart = await call('startMetaConnect', ownerT1, { tenantId: T1, mode: 'coexistence' });
const nStdSano = await call('startMetaConnect', ownerT1, { tenantId: T1, mode: 'standard' });
check('50. tampoco emite nonce estándar para Coexistence, y el flujo ESTÁNDAR sigue intacto',
  rModoStart.err === 'INVALID_ARGUMENT' && typeof nStdSano.result?.nonce === 'string' && nStdSano.result.mode === 'standard',
  `coex=${rModoStart.err} std=${nStdSano.result?.mode}`);

/**
 * 51. LA RECUPERACIÓN. El `ACCOUNT_OFFBOARDED` del check 46 dejó `inactive` en el asset **y en el
 * índice**. La migración documentada escribía solo el asset, y como el resolvedor aplica el MÁS
 * RESTRICTIVO, el número quedaba MUDO mientras el runbook reportaba éxito. Se corre la herramienta
 * real del runbook y se mide el modo EFECTIVO, que es lo único que decide si el número habla.
 */
const rMigracion = await migrarModoAutomatizacion(db, { tenantId: T1, phoneNumberId: PNID_COEX, mode: 'shadow', apply: true });
const assetRec = await asset(T1, PNID_COEX);
const idxRec = await indice(PNID_COEX);
check('51. tras un ACCOUNT_OFFBOARDED, la migración devuelve el número al modo pedido DE VERDAD (asset + índice)',
  rMigracion.outcome === 'written' && masRestrictivo(assetRec?.automationMode, idxRec?.automationMode) === 'shadow' &&
  assetRec?.status === 'active' && assetRec?.selected === false && assetRec?.connectionId === `wa_${PNID_COEX}`,
  `outcome=${rMigracion.outcome} indice=${rMigracion.indice} asset=${assetRec?.automationMode} idx=${idxRec?.automationMode}`);

// ---------------------------------------------------------------------------
// Restauración COMPLETA (convivencia con el resto de la batería)
// ---------------------------------------------------------------------------
await limpiarFixturesPropios();
for (const t of [T1, T2]) {
  await borrarDocs(await db.collection(`tenants/${t}/metaAssets`).get());
  await borrarDocs(await db.collection(`tenants/${t}/metaConnections`).get());
  await borrarDocs(await db.collection('metaExternalIndex').where('tenantId', '==', t).get());
  for (const a of snap.assets[t]) await db.doc(`tenants/${t}/metaAssets/${a.id}`).set(a.data);
  for (const c of snap.conns[t]) await db.doc(`tenants/${t}/metaConnections/${c.id}`).set(c.data);
  if (snap.tenants[t]) await db.doc(`tenants/${t}`).set(snap.tenants[t]);
}
for (const i of snap.idx) await db.doc(`metaExternalIndex/${i.id}`).set(i.data);
if (snap.channels) await db.doc(`tenants/${T1}/config/channels`).set(snap.channels); else await db.doc(`tenants/${T1}/config/channels`).delete().catch(() => {});
if (snap.agent) await db.doc(`tenants/${T1}/config/agent`).set(snap.agent); else await db.doc(`tenants/${T1}/config/agent`).delete().catch(() => {});
if (snap.graphFx) await db.doc('metaTestFixtures/graph').set(snap.graphFx); else await db.doc('metaTestFixtures/graph').delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO COEXISTENCE (ADR-0017): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);

/**
 * Siembra un número de Coexistence YA conectado, sin pasar por el Embedded Signup.
 *
 * Los casos `declined` y `expired` son del COORDINADOR, no del alta: hacerlos entrar por el flujo
 * real gastaría cupo del plan y ataría dos cosas que el ADR separa a propósito. `onboardedAtMs`
 * fija el `createdAt` de la conexión, que es de donde se DERIVA la ventana de 24 h (jamás se toma
 * del cliente).
 */
async function sembrarNumeroDeArchivo(pnid, onboardedAtMs) {
  const now = Timestamp.now();
  const creado = Timestamp.fromMillis(onboardedAtMs);
  await db.doc(`tenants/${T1}/metaConnections/wa_${pnid}`).set({
    id: `wa_${pnid}`, tenantId: T1, connectionId: `wa_${pnid}`, metaBusinessId: 'BIZ-COEX', metaBusinessName: 'Perfumería Coex',
    connectedUserId: '', tokenSecretRef: '', tokenType: 'live', tokenExpiresAt: null, scopes: [],
    status: 'active', source: 'embedded_signup', wabaId: WABA, lastVerifiedAt: now, errorMessage: '',
    createdAt: creado, updatedAt: now,
  });
  await db.doc(`tenants/${T1}/metaAssets/${pnid}`).set({
    id: pnid, tenantId: T1, connectionId: `wa_${pnid}`, assetType: 'whatsapp_phone_number', externalId: pnid,
    name: 'archivo', status: 'active', selected: false, sessionKey: `wa_${pnid}`, createdAt: now, updatedAt: now,
  });
  await db.doc(`metaExternalIndex/whatsapp_${pnid}`).set({
    id: `whatsapp_${pnid}`, tenantId: T1, connectionId: `wa_${pnid}`, assetType: 'whatsapp_phone_number',
    platform: 'whatsapp', externalId: pnid, status: 'active', updatedAt: now,
  });
}
