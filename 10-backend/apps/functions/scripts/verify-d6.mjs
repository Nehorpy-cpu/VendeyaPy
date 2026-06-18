/**
 * verify-d6.mjs — Verificación en vivo de businessEvents + Conversions API (D6).
 * Backfill + envío de eventos a Meta (demo); registro EN VIVO al confirmar un pago;
 * idempotencia; y reglas (vendedor no lee los eventos).
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = `http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents`;
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const now = Timestamp.now();

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const post = (p, b = {}) => fetch(`${BASE}/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: T, ...b }) }).then((r) => r.json());

await post('devMetaConnect'); // conexión + pixel (para que los eventos se "envíen")

// Pedido PAID atribuido + finanzas
await db.doc(`tenants/${T}/orders/d6-order`).set({ id: 'd6-order', tenantId: T, customerId: 'd6cust', status: 'PAID', items: [], channel: 'WHATSAPP', totals: { subtotal: 300000, discount: 0, total: 300000, currency: 'PYG' }, attribution: { campaignId: 'camp-1', adId: 'ad-1', type: 'direct_meta', confidence: 1, platform: 'whatsapp' }, createdAt: now, updatedAt: now });

// 1. Backfill + envío
await post('devProcessConversions');
const be = (await db.doc(`tenants/${T}/businessEvents/purchase-d6-order`).get()).data();
check('1. Evento de negocio Purchase creado (con monto + campaña)', be?.eventName === 'Purchase' && be?.value === 300000 && be?.campaignId === 'camp-1');
const ce = (await db.doc(`tenants/${T}/metaConversionEvents/conv-purchase-d6-order`).get()).data();
check('2. Evento enviado a la Conversions API (sent + pixel)', ce?.sendStatus === 'sent' && ce?.metaPixelId === 'px-600', `status=${ce?.sendStatus}`);

// 2. Idempotente
const before = (await db.collection(`tenants/${T}/metaConversionEvents`).get()).size;
await post('devProcessConversions');
const after = (await db.collection(`tenants/${T}/metaConversionEvents`).get()).size;
check('3. Re-procesar no duplica eventos', before === after, `${before}→${after}`);

// 3. EN VIVO: confirmar un pago registra el evento Purchase
const phone = '+595' + Math.floor(900000000 + Math.random() * 99999999);
const cid = phone.replace(/[^0-9]/g, '');
const msg = (t) => post('devMessage', { from: phone, text: t });
await msg('hola'); await msg('busco un perfume'); await msg('quiero el primero'); await msg('pagar');
const ord = (await db.collection(`tenants/${T}/orders`).where('customerId', '==', cid).get()).docs[0]?.id;
await post('devConfirmPayment', { from: phone });
const live = ord ? (await db.doc(`tenants/${T}/businessEvents/purchase-${ord}`).get()).exists : false;
check('4. Confirmar el pago registró el evento Purchase en vivo', live, `order=${ord}`);

// 4. Reglas: el vendedor NO lee los eventos
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const statusAs = async (tok) => (await fetch(`${FS}/tenants/${T}/businessEvents/purchase-d6-order`, { headers: { Authorization: `Bearer ${tok}` } })).status;
check('5. Vendedora NO lee los eventos (403)', (await statusAs(await signIn('seller@perfumeria.com'))) === 403);
check('6. Dueña SÍ lee los eventos (200)', (await statusAs(await signIn('owner@perfumeria.com'))) === 200);

// Limpieza del pedido de prueba + sus eventos
for (const p of ['orders/d6-order', 'businessEvents/purchase-d6-order', 'metaConversionEvents/conv-purchase-d6-order']) await db.doc(`tenants/${T}/${p}`).delete();

const ok = results.every((x) => x);
console.log(`\nRESULTADO D6: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((x) => x).length}/${results.length})`);
process.exit(ok ? 0 : 1);
