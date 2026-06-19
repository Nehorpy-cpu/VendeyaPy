/**
 * verify-fase5c-config.mjs — Config sensible por callable (Hardening F5C-A).
 * Verifica checkoutConfigUpdate / agentConfigUpdate / channelConfigUpdate: solo owner/admin
 * (seller 403), validación estricta de payload (400), whitelist de campos del agente, y que
 * channelConfigUpdate 'live' SOLO pasa si la conexión Meta es resoluble (si no, failed-precondition).
 * Audita los cambios. No cierra rules ni toca el frontend.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';
process.env.TENANT_SECRETS_ENCRYPTION_KEY ??= 'test-tenant-encryption-key-000000000000000';

import { randomBytes, createCipheriv, scryptSync } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTHURL = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const SALT = Buffer.from('vpw-tenant-secrets-v1');
const encrypt = (pt) => { const iv = randomBytes(16); const key = scryptSync(process.env.TENANT_SECRETS_ENCRYPTION_KEY, SALT, 32); const c = createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(pt, 'utf8'), c.final()]); return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${e.toString('base64')}`; };

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTHURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function callFn(fn, data, idToken) {
  const res = await fetch(`${BASE}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` }, body: JSON.stringify({ data }) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, result: json.result, error: json.error };
}
const doc = (p) => db.doc(p).get().then((s) => s.data());

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

// estado limpio
await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'not_connected', tokenSecretRef: '' }, { merge: true }).catch(() => {});
for (const d of (await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get()).docs) await d.ref.delete();
await db.doc('secrets/meta-token-perfumeria').delete().catch(() => {});

// 1. checkoutConfigUpdate (owner) válido
const c1 = await callFn('checkoutConfigUpdate', { tenantId: T, data: { bankAccounts: [{ bank: 'Itaú', accountNumber: '123', holder: 'Marco', document: '111' }], sellers: [{ name: 'Ana', whatsapp: '+595981111111', active: true }] } }, owner);
const co = await doc(`tenants/${T}/config/checkout`);
check('1. checkoutConfigUpdate (owner) → guardado', c1.status === 200 && co?.bankAccounts?.length === 1 && co?.sellers?.length === 1, `status=${c1.status}`);

// 2. payload inválido → 400
const c2 = await callFn('checkoutConfigUpdate', { tenantId: T, data: { bankAccounts: [{ bank: 'X' }] } }, owner);
check('2. checkoutConfigUpdate payload inválido → 400', c2.status === 400, `status=${c2.status}`);

// 3. seller → 403
const c3 = await callFn('checkoutConfigUpdate', { tenantId: T, data: { bankAccounts: [], sellers: [] } }, seller);
check('3. checkoutConfigUpdate vendedor → 403', c3.status === 403, `status=${c3.status}`);

// 4. agentConfigUpdate (owner) → whitelist (descarta planId)
const a1 = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'Sofía Test', botEnabled: false, planId: 'pro', limits: { maxProducts: 9 } } }, owner);
const ag = await doc(`tenants/${T}/config/agent`);
check('4. agentConfigUpdate (owner) aplica whitelist (sin planId/limits)', a1.status === 200 && ag?.agentName === 'Sofía Test' && ag?.botEnabled === false && ag?.planId === undefined, `status=${a1.status} planId=${ag?.planId}`);

// 5. agentConfigUpdate seller → 403
const a2 = await callFn('agentConfigUpdate', { tenantId: T, data: { agentName: 'x' } }, seller);
check('5. agentConfigUpdate vendedor → 403', a2.status === 403, `status=${a2.status}`);

// 6. channelConfigUpdate mock → ok
const ch1 = await callFn('channelConfigUpdate', { tenantId: T, data: { whatsappSendMode: 'mock' } }, owner);
check('6. channelConfigUpdate mock (owner) → ok', ch1.status === 200 && ch1.result?.whatsappSendMode === 'mock', `status=${ch1.status}`);

// 7. channelConfigUpdate live SIN conexión → failed-precondition (400)
const ch2 = await callFn('channelConfigUpdate', { tenantId: T, data: { whatsappSendMode: 'live' } }, owner);
check('7. channelConfigUpdate live sin conexión → 400 (failed-precondition)', ch2.status === 400 && /no podés activar/i.test(ch2.error?.message ?? ''), `status=${ch2.status} msg=${ch2.error?.message}`);

// 8. channelConfigUpdate live CON conexión resoluble → ok
await db.doc('secrets/meta-token-perfumeria').set({ name: 'meta-token-perfumeria', ciphertext: encrypt('EAA-cfg'), updatedAt: Timestamp.now() });
await db.doc(`tenants/${T}/metaConnections/main`).set({ id: 'main', tenantId: T, status: 'active', tokenSecretRef: 'secret://firestore/meta-token-perfumeria', tokenType: 'live', tokenExpiresAt: Timestamp.fromMillis(Date.now() + 3_600_000), scopes: ['whatsapp_business_messaging'], lastVerifiedAt: Timestamp.now(), errorMessage: '', createdAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
await db.doc(`tenants/${T}/metaAssets/wa-cfg`).set({ id: 'wa-cfg', tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: 'wa-cfg', name: 'wa', status: 'active', selected: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const ch3 = await callFn('channelConfigUpdate', { tenantId: T, data: { whatsappSendMode: 'live' } }, owner);
check('8. channelConfigUpdate live con conexión resoluble → ok', ch3.status === 200 && ch3.result?.whatsappSendMode === 'live', `status=${ch3.status} ${JSON.stringify(ch3.error ?? '')}`);

// 9. admin con tenant objetivo (boutique-demo) → ok; admin sin tenantId → 400
const c9 = await callFn('checkoutConfigUpdate', { tenantId: 'boutique-demo', data: { bankAccounts: [], sellers: [] } }, admin);
const c9b = await callFn('checkoutConfigUpdate', { data: { bankAccounts: [], sellers: [] } }, admin);
check('9. admin con tenant → ok; admin sin tenantId → 400', c9.status === 200 && c9b.status === 400, `conTenant=${c9.status} sinTenant=${c9b.status}`);

// 10. Auditoría
const audits = await db.collection(`tenants/${T}/auditLogs`).where('action', 'in', ['channelConfig.updated', 'checkout.updated', 'agentConfig.updated']).get();
const actions = new Set(audits.docs.map((d) => d.data().action));
check('10. Cambios auditados (checkout/agentConfig/channelConfig)', actions.has('checkout.updated') && actions.has('agentConfig.updated') && actions.has('channelConfig.updated'), `actions=${[...actions].join(',')}`);

// --- Limpieza: restaurar perfumeria a estado demo ---
await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/checkout`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true }, { merge: true });
await db.doc(`tenants/${T}/metaConnections/main`).set({ status: 'not_connected', tokenSecretRef: '' }, { merge: true });
await db.doc(`tenants/${T}/metaAssets/wa-cfg`).delete().catch(() => {});
await db.doc('secrets/meta-token-perfumeria').delete().catch(() => {});
await db.doc('tenants/boutique-demo/config/checkout').delete().catch(() => {});
for (const d of (await db.collection(`tenants/${T}/auditLogs`).get()).docs) await d.ref.delete().catch(() => {});

const ok = results.every((x) => x);
console.log(`\nRESULTADO HARDENING F5C-A (config sensible por callable): ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
