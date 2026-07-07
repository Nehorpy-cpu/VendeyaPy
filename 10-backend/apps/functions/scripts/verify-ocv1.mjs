/**
 * verify-ocv1.mjs — ORDER-COMPROBANTE-VIEW-1 end-to-end (emulador, requiere STORAGE emulator).
 * El vendedor VE el comprobante desde el panel vía enlace temporal seguro:
 *   1. owner / seller / PLATFORM_ADMIN obtienen URL y la imagen se descarga.
 *   2. cross-tenant (owner de boutique-demo) → permission-denied.
 *   3. orden sin comprobante → error claro.
 *   4. referencia media:{id} (descarga pendiente) → error claro.
 *   5. referencia adulterada (path de OTRO tenant en el doc) → rechazo.
 *   6. archivo inexistente → not-found claro.
 *   7. la orden NO se modifica (lectura pura) y la URL firmada no queda en Firestore.
 *
 * Requiere: emulador (auth+firestore+functions+storage) + seed-users.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

initializeApp({ projectId: 'demo-aiafg', storageBucket: 'demo-aiafg.appspot.com' });
const db = getFirestore();
const bucket = getStorage().bucket();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
const call = async (idToken, data) => {
  const r = await fetch(`${BASE}/orderGetComprobanteViewUrl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, result: body.result, error: body.error };
};

// ---- Seed: órdenes de prueba + archivo simulado en Storage ----
const now = Timestamp.now();
const orderBase = (id, comprobanteUrl) => ({
  id, tenantId: T, customerId: '595990000001', status: 'PENDING_VERIFICATION',
  items: [{ itemId: 'i1', productId: 'p1', productName: 'Perfume Test', quantity: 1, unitPrice: 100000, subtotal: 100000 }],
  totals: { subtotal: 100000, discount: 0, delivery: 0, total: 100000 },
  payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl },
  delivery: { deliveryId: null, address: { street: '', city: '', reference: '' } },
  invoice: { invoiceId: null, ruc: null, razonSocial: null },
  channel: 'whatsapp', sellerId: null, source: 'verify-ocv1', notes: '', createdAt: now, updatedAt: now,
});

const OK_ID = 'ocv1-ok';
const OK_PATH = `tenants/${T}/orders/${OK_ID}/comprobantes/wamid.OCV1-test.jpg`;
// JPEG mínimo válido (bytes de cabecera + fin) — alcanza para servirlo como imagen.
const FAKE_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
await bucket.file(OK_PATH).save(FAKE_JPG, { contentType: 'image/jpeg' });
await db.doc(`tenants/${T}/orders/${OK_ID}`).set(orderBase(OK_ID, OK_PATH));
await db.doc(`tenants/${T}/orders/ocv1-sin`).set(orderBase('ocv1-sin', null));
await db.doc(`tenants/${T}/orders/ocv1-media`).set(orderBase('ocv1-media', 'media:MEDIA123'));
await db.doc(`tenants/${T}/orders/ocv1-mal`).set(orderBase('ocv1-mal', `tenants/boutique-demo/orders/${OK_ID}/comprobantes/robado.jpg`));
await db.doc(`tenants/${T}/orders/ocv1-nofile`).set(orderBase('ocv1-nofile', `tenants/${T}/orders/ocv1-nofile/comprobantes/no-existe.jpg`));
const snapshotAntes = JSON.stringify((await db.doc(`tenants/${T}/orders/${OK_ID}`).get()).data());

// ---- 1. owner / seller / admin ven la imagen ----
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');

for (const [quien, token, data] of [
  ['owner', owner, { orderId: OK_ID }],
  ['seller', seller, { orderId: OK_ID }],
  ['PLATFORM_ADMIN', admin, { tenantId: T, orderId: OK_ID }],
]) {
  const r = await call(token, data);
  const url = r.result?.url ?? '';
  let img = { status: 0, type: '' };
  if (url) {
    const ir = await fetch(url);
    img = { status: ir.status, type: ir.headers.get('content-type') ?? '' };
  }
  check(`1. ${quien} obtiene URL temporal y la imagen se descarga`,
    r.status === 200 && !!url && img.status === 200 && img.type.startsWith('image/'),
    `http=${r.status} img=${img.status} ${img.type}`);
}

// ---- 2. cross-tenant → denegado ----
{
  const ajeno = await signIn('owner@boutique.com');
  const r = await call(ajeno, { tenantId: T, orderId: OK_ID }); // aunque PIDA el tenant ajeno, se ignora → orden inexistente en SU tenant
  check('2. cross-tenant denegado (owner de boutique-demo no ve comprobantes de perfumeria)',
    r.status !== 200 && (r.error?.status === 'NOT_FOUND' || r.error?.status === 'PERMISSION_DENIED'),
    `http=${r.status} status=${r.error?.status}`);
}

// ---- 3-6. errores claros ----
{
  const r = await call(owner, { orderId: 'ocv1-sin' });
  check('3. orden sin comprobante → error claro', r.status !== 200 && /todavía no tiene comprobante/i.test(r.error?.message ?? ''), r.error?.message);
}
{
  const r = await call(owner, { orderId: 'ocv1-media' });
  check('4. referencia media:{id} → "imagen no disponible" claro', r.status !== 200 && /no está disponible/i.test(r.error?.message ?? ''), r.error?.message);
}
{
  const r = await call(owner, { orderId: 'ocv1-mal' });
  check('5. referencia adulterada (path de otro tenant) → rechazo', r.status !== 200 && /no es válida/i.test(r.error?.message ?? ''), r.error?.message);
}
{
  const r = await call(owner, { orderId: 'ocv1-nofile' });
  check('6. archivo inexistente → not-found claro', r.status !== 200 && /no se encontró/i.test(r.error?.message ?? ''), r.error?.message);
}

// ---- 7. lectura pura: la orden no cambió y ninguna URL quedó persistida ----
{
  const despues = (await db.doc(`tenants/${T}/orders/${OK_ID}`).get()).data();
  const igual = JSON.stringify(despues) === snapshotAntes;
  const sinUrlFirmada = !JSON.stringify(despues).includes('token=') && !JSON.stringify(despues).includes('X-Goog-Signature');
  check('7. la orden NO se modificó y no se persistió ninguna URL firmada', igual && sinUrlFirmada);
}

// ---- Cleanup ----
for (const id of [OK_ID, 'ocv1-sin', 'ocv1-media', 'ocv1-mal', 'ocv1-nofile']) {
  await db.doc(`tenants/${T}/orders/${id}`).delete();
}
await bucket.file(OK_PATH).delete().catch(() => {});

const ok = results.every(Boolean);
console.log(`\nRESULTADO OCV-1 (ver comprobante en el panel): ${ok ? 'TODO OK ✅' : 'FALLOS ❌'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
