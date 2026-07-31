/**
 * verify-attachments.mjs — WHATSAPP-MEDIA-SAFE-FOUNDATION-1 / ADR-0016 (emulador limpio).
 * ADJUNTOS DE CONVERSACIÓN SEGUROS y clasificación SEPARADA del pago, de punta a punta y sin
 * WhatsApp real (el webhook entra por `metaWebhook`, la descarga la stubea el emulador):
 *   el archivo existe ANTES de significar algo · el gate determinístico propone pero NUNCA mueve
 *   un pedido · el pago es una decisión HUMANA que llega hasta PENDING_VERIFICATION y jamás a
 *   PAID · idempotencia por (tenant, canal, providerMessageId, providerMediaId) · rechazos que
 *   no bloquean la conversación · Storage privado con id opaco y URL firmada de vida corta ·
 *   compatibilidad aditiva con los comprobantes legacy · cero IA sobre el archivo o su caption.
 *
 * Checks numerados AT-N (uno por escenario de la etapa G del programa; letras = sub-asserts).
 *
 * QUÉ SE CORRE EN PROCESO Y POR QUÉ (AT-12/13/14/17): el stub de descarga del EMULADOR devuelve
 * SIEMPRE un archivo válido, así que por el webhook es IMPOSIBLE llegar a `rejected` o a
 * `download_failed`. Esos tres escenarios se ejercitan contra el CÓDIGO REAL de producción
 * (`downloadWhatsappAttachment` + `ingestInboundAttachment` de la lib compilada) inyectando SOLO
 * el transporte (un `fetch` falso: cero red) y escribiendo contra el MISMO emulador de Firestore
 * y Storage. No se relaja nada: el rechazo lo produce el módulo real, no el fixture.
 *
 * LO MISMO PARA LA FIRMA (AT-11c/11d). El emulador de Storage no tiene clave privada: `getSignedUrl`
 * v4 falla con "Could not load the default credentials", así que su única salida de bytes es
 * `?alt=media&token=…`, y ese endpoint NO admite `Content-Disposition`. Un PDF —que por contrato se
 * BAJA, no se renderiza— entonces jamás puede emitirse desde el emulador. Se parte en dos: AT-11c
 * afirma la DECISIÓN contra el emisor real (deps reales de Firestore/Storage, transporte inyectado)
 * leyendo lo que llega al firmante —más fuerte que leer el campo de la respuesta—, y AT-11d afirma
 * la CONSECUENCIA en el emulador: prefiere no emitir antes que servir el PDF inline. Por qué el
 * token de descarga lo siembra el ARNÉS y no el producto: ver `sembrarTokenDeDescarga`.
 *
 * Requiere: emuladores (auth+functions+firestore+storage) + seed-users + load-catalog.
 * Es RE-EJECUTABLE sobre el mismo emulador (limpia lo suyo al empezar y restaura config al salir).
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

initializeApp({ projectId: 'demo-aiafg', storageBucket: 'demo-aiafg.appspot.com' });
const db = getFirestore();
const bucket = getStorage().bucket();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const T2 = 'boutique-demo';
const PNID = 'wa-att-1';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
/** Callable AUTENTICADA. `token === null` ⇒ llamada ANÓNIMA (sin header Authorization). */
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, errMsg: body.error?.message ?? null };
}
/** El "cliente" de las pruebas de rules ES la API REST de Firestore con el idToken del usuario. */
const restGet = (path, token) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
const restPatch = (path, token, fields) =>
  fetch(`${FS}/${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields }) }).then((r) => r.status);

// Identidad y rutas REALES (las mismas funciones que usa el backend: si la fórmula cambiara,
// este E2E falla en vez de validar un id inventado por el test).
const {
  deriveAttachmentId, hashProviderMessageId, buildAttachmentStoragePath, buildAttachmentDocPath,
  isAttachmentId, ATTACHMENT_ALLOWED_MIME_TYPES,
} = await import('@vpw/shared');
const { downloadWhatsappAttachment } = await import(new URL('../lib/meta/mediaClient.js', import.meta.url).href);
const { ingestInboundAttachment, ATTACHMENT_REPLIES } = await import(new URL('../lib/meta/attachmentIngest.js', import.meta.url).href);
const { MENSAJE_COMPROBANTE_PROPUESTO } = await import(new URL('../lib/orders/receiptAttachmentGate.js', import.meta.url).href);
const { issueAttachmentViewUrl, ATTACHMENT_VIEW_URL_MAX_TTL_MS, defaultAttachmentViewDeps } = await import(new URL('../lib/attachments/mediaUrlIssuer.js', import.meta.url).href);

const now = Timestamp.now();

// ═══════════════════════════════════════════════════════════════════════════
// Clientes del programa. Uno por escenario: una sesión/conversación reusada
// escondería exactamente el turno que se quiere probar.
// ═══════════════════════════════════════════════════════════════════════════
const C = {
  sinPedido: '595984100001',      // AT-1
  sinContexto: '595984100002',    // AT-2
  candidato: '595984100003',      // AT-3 · AT-4 · AT-15..18 (el adjunto "canónico")
  desmarca: '595984100005',       // AT-5
  desmarcaPaid: '595984100006',   // AT-6 · AT-22 (control positivo del ÚNICO camino a PAID)
  ajeno: '595984100007',          // AT-7 (manda el archivo)
  duenoReal: '595984100017',      // AT-7 (dueño del pedido apuntado por la sesión de `ajeno`)
  ambiguo: '595984100008',        // AT-8
  acumula: '595984100009',        // AT-9
  reintento: '595984100010',      // AT-10
  pdf: '595984100011',            // AT-11
  mimeFalso: '595984100012',      // AT-12
  oversize: '595984100013',       // AT-13
  descargaFallida: '595984100014',// AT-14
  legacy: '595984100019',         // AT-19
  textoFalso: '595984100020',     // AT-20
  rolloutGateOff: '595984100021', // AT-23a..f (nivel B apagado)
  rolloutIngestOff: '595984100022',// AT-23g..k (nivel A apagado)
};
const CLIENTES = Object.values(C);

const attachmentsCol = (tenant = T) => db.collection(`tenants/${tenant}/attachments`);
const attachmentsDe = async (customerId, tenant = T) =>
  (await attachmentsCol(tenant).where('customerId', '==', customerId).get()).docs.map((d) => d.data());
const attachmentDoc = async (attachmentId, tenant = T) => (await db.doc(buildAttachmentDocPath(tenant, attachmentId)).get()).data() ?? null;
const orderDoc = async (id, tenant = T) => (await db.doc(`tenants/${tenant}/orders/${id}`).get()).data() ?? null;
const sessionDoc = async (customerId, tenant = T) => (await db.doc(`tenants/${tenant}/customers/${customerId}/sessions/active`).get()).data() ?? null;
const mensajesDe = async (customerId, tenant = T) =>
  (await db.collection(`tenants/${tenant}/customers/${customerId}/messages`).get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
const auditsDe = async (action, tenant = T) =>
  (await db.collection(`tenants/${tenant}/auditLogs`).where('action', '==', action).get()).docs.map((d) => d.data());
const usoIa = async (tenant = T) => {
  const u = (await db.doc(`tenants/${tenant}`).get()).data()?.usage ?? {};
  return { tokens: u.aiTokensThisMonth ?? 0, costo: u.aiCostUsdThisMonth ?? 0 };
};

/**
 * Token de descarga que el ARNÉS le pone al objeto, y por qué tiene que ponerlo el arnés.
 *
 * El emulador de Storage no tiene clave privada: `getSignedUrl` v4 muere con "Could not load the
 * default credentials" (verificado). Su único modo de servir bytes es `?alt=media&token=…`, y ese
 * token sale de la metadata del objeto. La ingesta de producción —correctamente— NUNCA escribe uno:
 * un `firebaseStorageDownloadTokens` sobre el archivo de un cliente es una credencial ETERNA, que es
 * justo lo contrario del techo de 10 minutos de ADR-0016 §6. Por eso `existingDownloadToken` está
 * especificado como "el token que el objeto YA tenga; nunca se inventa uno".
 *
 * Consecuencia: en el emulador nadie le da un token al objeto y el visor no puede emitir NADA.
 * La afordancia de desarrollo va acá, en el fixture, no en el producto: el arnés siembra el token
 * previo y el emisor real hace lo que su contrato dice —reutilizarlo—. Así el callable se ejercita
 * de punta a punta (auditoría incluida) sin que el código de producción persista una credencial.
 */
async function sembrarTokenDeDescarga(path) {
  const token = randomUUID();
  await bucket.file(path).setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  return token;
}

async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = db.batch();
    for (const r of refs.slice(i, i + 400)) b.delete(r);
    await b.commit();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ WHATSAPP-MEDIA-SAFE-FOUNDATION-1 (ADR-0016) · E2E de adjuntos, sin Meta real ═══\n');

const sentMids = [];
const createdOrders = [];
const storagePathsCreados = [];

/** Limpieza idempotente: el script se puede re-correr sin reiniciar el emulador. */
async function wipePrograma() {
  for (const c of CLIENTES) {
    await deleteRefs((await attachmentsCol().where('customerId', '==', c).get()).docs.map((d) => d.ref));
    await deleteRefs((await attachmentsCol(T2).where('customerId', '==', c).get()).docs.map((d) => d.ref));
    await deleteRefs((await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs.map((d) => d.ref));
    await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
    await db.doc(`tenants/${T}/customers/${c}`).delete().catch(() => {});
    const pedidos = await db.collection(`tenants/${T}/orders`).where('customerId', '==', c).get();
    for (const d of pedidos.docs) {
      await db.doc(`tenants/${T}/handoffs/${d.id}`).delete().catch(() => {});
      await db.doc(`tenants/${T}/businessEvents/purchase-${d.id}`).delete().catch(() => {});
      const files = await bucket.getFiles({ prefix: `tenants/${T}/orders/${d.id}/comprobantes/` }).then(([f]) => f).catch(() => []);
      for (const f of files) await f.delete().catch(() => {});
    }
    await deleteRefs(pedidos.docs.map((d) => d.ref));
  }
  // Bytes huérfanos de una corrida anterior: la partición es función pura del id, así que un
  // archivo viejo con el mismo id haría pasar "el archivo existe" sin haberlo subido hoy.
  const viejos = await bucket.getFiles({ prefix: `tenants/${T}/attachments/` }).then(([f]) => f).catch(() => []);
  for (const f of viejos) await f.delete().catch(() => {});
  // Auditoría del programa (los contadores exactos de AT-4/5/17 no toleran residuos).
  for (const accion of ['order.receipt_marked', 'order.receipt_unmarked', 'attachment.view_url_issued']) {
    await deleteRefs((await db.collection(`tenants/${T}/auditLogs`).where('action', '==', accion).get()).docs.map((d) => d.ref));
  }
}
await wipePrograma();

// Ruteo del webhook a `perfumeria` (asset + índice global), modo mock, bot prendido.
const assetsPrevios = await db.collection(`tenants/${T}/metaAssets`).where('assetType', '==', 'whatsapp_phone_number').get();
const assetsPreviosDocs = assetsPrevios.docs.map((d) => ({ id: d.id, data: d.data() }));
for (const d of assetsPrevios.docs) await d.ref.delete();
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ id: PNID, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', externalId: PNID, name: 'wa-att', status: 'active', selected: true, createdAt: now, updatedAt: now });
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ id: `whatsapp_${PNID}`, tenantId: T, connectionId: 'main', assetType: 'whatsapp_phone_number', platform: 'whatsapp', externalId: PNID, status: 'active', updatedAt: now });
const channelsPrevio = (await db.doc(`tenants/${T}/config/channels`).get()).data() ?? null;
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
const agentPrevio = (await db.doc(`tenants/${T}/config/agent`).get()).data() ?? null;
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot de la prueba' }, { merge: true });
// ROLLOUT (ADR-0016 §10). Los dos niveles nacen APAGADOS: desplegar no enciende nada para nadie.
// Todo lo que verifica AT-1..AT-22 es la fundación FUNCIONANDO, así que hay que encenderla a
// propósito — igual que habrá que hacerlo en producción, tenant por tenant. Que este bloque sea
// necesario ES parte de la garantía: si se borrara, el script fallaría en AT-1, que es
// exactamente lo que tiene que pasar cuando los flags no están.
// Los flags van en `set` con merge para no pisar `retention` si otra corrida lo dejó escrito, y
// el resto de la config del gate queda en sus DEFAULTS (ventana 24 h, formatos del contrato): un
// doc heredado de otra corrida cambiaría la ventana y AT-3 sería un espejismo.
const attachmentsCfgPrevio = (await db.doc(`tenants/${T}/config/attachments`).get()).data() ?? null;
await db.doc(`tenants/${T}/config/attachments`).set({ ingest: { enabled: true } }, { merge: true });
await db.doc(`tenants/${T}/config/receiptGate`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/receiptGate`).set({ enabled: true });

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');
const ownerBoutique = await signIn('owner@boutique.com');

const IA_ANTES = await usoIa();

// ── Helpers del webhook ───────────────────────────────────────────────────
let midSeq = 0;
const nuevoMid = (etiqueta) => {
  const mid = `wamid.ATT-${etiqueta}-${Date.now()}-${++midSeq}`;
  sentMids.push(mid);
  return mid;
};
function cuerpoWebhook(from, mid, mensaje) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PNID },
      contacts: [{ wa_id: from, profile: { name: 'Cliente E2E' } }],
      messages: [{ from, id: mid, timestamp: '1716750000', ...mensaje }],
    } }] }],
  };
}
const postWebhook = async (from, mid, mensaje) => {
  const res = await fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpoWebhook(from, mid, mensaje)) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
/** Espera a que el TRIGGER termine con el evento (processed/ignored/failed). */
async function esperarEvento(mid, maxMs = 25_000) {
  const ref = db.doc(`metaWebhookInbox/whatsapp_${mid.replace(/[^\w.:=+-]/g, '_').slice(0, 256)}`);
  const fin = Date.now() + maxMs;
  while (Date.now() < fin) {
    const d = (await ref.get()).data();
    if (d && d.processingStatus !== 'received' && d.processingStatus !== 'processing') return d;
    await sleep(400);
  }
  return (await ref.get()).data() ?? null;
}
/** Manda una imagen/PDF por el webhook REAL y devuelve el adjunto ya procesado. */
async function mandarArchivo(from, { kind = 'image', mediaId, mime = 'image/jpeg', caption = '', filename = null, mid = null } = {}) {
  const wamid = mid ?? nuevoMid(kind);
  const media = { id: mediaId, mime_type: mime, ...(caption ? { caption } : {}), ...(filename ? { filename } : {}) };
  const { status, body } = await postWebhook(from, wamid, { type: kind, [kind]: media });
  const evento = await esperarEvento(wamid);
  const attachmentId = deriveAttachmentId({ tenantId: T, channel: 'whatsapp', providerMessageId: wamid, providerMediaId: mediaId });
  // El trigger escribe el estado final del adjunto DESPUÉS de marcar el evento: se espera al doc.
  const fin = Date.now() + 15_000;
  let doc = null;
  while (Date.now() < fin) {
    doc = await attachmentDoc(attachmentId);
    if (doc && ['stored', 'rejected', 'download_failed'].includes(doc.ingestState)) break;
    await sleep(300);
  }
  return { status, body, evento, wamid, attachmentId, attachment: doc };
}
/** Espera a que la clasificación del gate quede asentada (corre después de la ingesta). */
async function esperarClasificacion(attachmentId, valor, maxMs = 12_000) {
  const fin = Date.now() + maxMs;
  let doc = null;
  while (Date.now() < fin) {
    doc = await attachmentDoc(attachmentId);
    if (doc?.classification?.value === valor) return doc;
    await sleep(300);
  }
  return doc;
}

// ── Pedidos del programa ──────────────────────────────────────────────────
let ordSeq = 0;
async function mkOrder(customerId, status = 'PENDING_PAYMENT', over = {}) {
  const id = `ordatt_${Date.now()}_${++ordSeq}`;
  await db.doc(`tenants/${T}/orders/${id}`).set({
    id, tenantId: T, customerId, status,
    items: [{ itemId: 'i1', productId: 'lattafa-yara', productName: 'Yara', unitPrice: 180000, quantity: 1, subtotal: 180000 }],
    totals: { subtotal: 180000, discount: 0, total: 180000, currency: 'PYG' },
    payment: { method: 'BANCARD', paymentId: '', paidAt: null, comprobanteUrl: null },
    delivery: { deliveryId: null, address: { street: '', houseNumber: '', city: '', neighborhood: '', reference: '', coordinates: null } },
    invoice: { invoiceId: null, number: null }, channel: 'WHATSAPP', sellerId: null, source: 'verify-attachments', notes: '',
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...over,
  });
  createdOrders.push({ id, customerId });
  return id;
}
/** Sesión con el contexto de espera DECLARADO por el servidor (jamás inferido del archivo). */
const setSesion = (customerId, over = {}) =>
  db.doc(`tenants/${T}/customers/${customerId}/sessions/active`).set({
    id: 'active', tenantId: T, customerId, state: 'IDLE',
    cart: { items: [], subtotal: 0 }, context: { pendingOrderId: null }, updatedAt: Timestamp.now(), ...over,
  });

// ═══════════════════════════════════════════════════════════════════════════
// AT-1. Imagen SIN pedido: se guarda, se ve en el chat, queda `generic_media`
//       y NO produce ni una sola mutación comercial.
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = await mandarArchivo(C.sinPedido, { mediaId: 'MEDIA-AT-1', caption: 'cuánto sale este?' });
  const doc = await esperarClasificacion(r.attachmentId, 'generic_media');
  const path = buildAttachmentStoragePath(T, r.attachmentId);
  const [existe] = await bucket.file(path).exists();
  storagePathsCreados.push(path);
  check('AT-1. una imagen sin pedido pendiente SE GUARDA (antes se perdía para siempre)',
    r.status === 200 && doc?.ingestState === 'stored' && doc?.storage?.path === path && existe,
    `status=${r.status} ingest=${doc?.ingestState} archivo=${existe}`);
  check('AT-1b. queda `generic_media` por REGLA (el sistema no adivina qué es la foto)',
    doc?.classification?.value === 'generic_media' && doc?.classification?.source === 'rule' && doc?.orderCandidateId === null,
    `class=${doc?.classification?.value}/${doc?.classification?.source} candidato=${doc?.orderCandidateId}`);
  const msgs = await mensajesDe(C.sinPedido);
  const burbuja = msgs.find((m) => (m.attachmentIds ?? []).includes(r.attachmentId));
  check('AT-1c. el chat lo muestra por PUNTEROS (`attachmentIds`/`hasAttachments`), no por texto',
    !!burbuja && burbuja.hasAttachments === true && burbuja.direction === 'in',
    `burbujas=${msgs.length} punteros=${JSON.stringify(burbuja?.attachmentIds)}`);
  // ADR-0016 §9: el TEXTO de la burbuja es un marcador del sistema. El caption es texto libre del
  // cliente y no puede quedar en `messages`, porque de ahí sale el historial que recibe la IA.
  check('AT-1c2. el caption NO quedó como texto de ningún mensaje (sí en el adjunto)',
    burbuja?.text === '📷 Imagen recibida' && msgs.every((m) => m.text !== 'cuánto sale este?') &&
    doc?.caption === 'cuánto sale este?',
    `texto=${JSON.stringify(burbuja?.text)} caption=${JSON.stringify(doc?.caption)}`);
  const sesion = await sessionDoc(C.sinPedido);
  const pedidos = await db.collection(`tenants/${T}/orders`).where('customerId', '==', C.sinPedido).get();
  const handoff = await db.collection(`tenants/${T}/handoffs`).get();
  // El caption SÍ pasa por las reglas del motor (una pregunta con foto no puede quedar sin
  // respuesta), y eso crea sesión de conversación: lo que no puede haber es mutación COMERCIAL.
  check('AT-1d. CERO mutación comercial: sin pedido, sin handoff y sin takeover del bot',
    pedidos.empty && handoff.docs.every((d) => d.data().customerId !== C.sinPedido) &&
    sesion?.context?.humanTakeover !== true,
    `sesion=${sesion === null ? 'no' : 'sí'} pedidos=${pedidos.size} takeover=${sesion?.context?.humanTakeover}`);
  check('AT-1d2. y al cliente se le RESPONDE algo (un archivo nunca queda en silencio)',
    msgs.some((m) => m.direction === 'out' && (m.text ?? '').trim() !== ''),
    `salidas=${msgs.filter((m) => m.direction === 'out').length}`);
  check('AT-1e. el id y la ruta son OPACOS: ni el teléfono, ni el mediaId, ni el wamid crudo',
    isAttachmentId(r.attachmentId) && !path.includes(C.sinPedido) && !path.includes('MEDIA-AT-1') &&
    !JSON.stringify(doc).includes('MEDIA-AT-1') && !JSON.stringify(doc).includes(r.wamid) &&
    doc?.providerMessageId === hashProviderMessageId(T, r.wamid),
    `path=…/${path.split('/').slice(-2).join('/')}`);
  check('AT-1f. el mediaId se ANULA del inbox una vez que los bytes son nuestros',
    r.evento?.processingStatus === 'processed' && (r.evento?.payload?.attachment?.mediaId ?? null) === null,
    `estado=${r.evento?.processingStatus} mediaId=${r.evento?.payload?.attachment?.mediaId ?? 'null'}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-2. Imagen CON pedido pendiente pero SIN contexto explícito de pago ⇒ medio normal.
//       Éste es el defecto #1 de la auditoría: alcanzaba con "es una imagen".
// ═══════════════════════════════════════════════════════════════════════════
{
  const orderId = await mkOrder(C.sinContexto);
  await setSesion(C.sinContexto, { state: 'BROWSING', context: { pendingOrderId: orderId } });
  const r = await mandarArchivo(C.sinContexto, { mediaId: 'MEDIA-AT-2', caption: 'mirá qué lindo' });
  const doc = await esperarClasificacion(r.attachmentId, 'generic_media');
  const o = await orderDoc(orderId);
  const sesion = await sessionDoc(C.sinContexto);
  check('AT-2. con pedido pendiente pero SIN contexto declarado la imagen es un medio normal',
    doc?.ingestState === 'stored' && doc?.classification?.value === 'generic_media' && doc?.orderCandidateId === null,
    `class=${doc?.classification?.value}`);
  check('AT-2b. el pedido NO se movió, no hay comprobante y el bot NO fue sacado del chat',
    o?.status === 'PENDING_PAYMENT' && !o?.payment?.comprobanteUrl && !o?.payment?.paidAt &&
    sesion?.context?.humanTakeover !== true && !(await db.doc(`tenants/${T}/handoffs/${orderId}`).get()).exists,
    `status=${o?.status} takeover=${sesion?.context?.humanTakeover}`);
  check('AT-2c. y el pedido no quedó con candidatos: una foto cualquiera no es evidencia de pago',
    (o?.receiptAttachments?.candidateIds ?? []).length === 0 && (o?.receiptAttachments?.linkedIds ?? []).length === 0,
    `candidatos=${JSON.stringify(o?.receiptAttachments?.candidateIds ?? [])}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-3. Contexto de pago DECLARADO + un solo pedido admisible del MISMO cliente
//       ⇒ `payment_receipt_candidate`. Sugerencia visible: el pedido NO cambia de estado.
// ═══════════════════════════════════════════════════════════════════════════
let ordenCandidato = null;
let adjuntoCandidato = null;
{
  ordenCandidato = await mkOrder(C.candidato);
  await setSesion(C.candidato, { state: 'AWAITING_PAYMENT', context: { pendingOrderId: ordenCandidato } });
  const r = await mandarArchivo(C.candidato, { mediaId: 'MEDIA-AT-3', caption: 'ahí va el comprobante' });
  adjuntoCandidato = r.attachmentId;
  const doc = await esperarClasificacion(r.attachmentId, 'payment_receipt_candidate');
  const o = await orderDoc(ordenCandidato);
  check('AT-3. contexto declarado + pedido único del MISMO cliente ⇒ payment_receipt_candidate',
    doc?.classification?.value === 'payment_receipt_candidate' && doc?.classification?.source === 'rule' &&
    doc?.classification?.confidence === 1 && doc?.orderCandidateId === ordenCandidato,
    `class=${doc?.classification?.value} pedido=${doc?.orderCandidateId === ordenCandidato}`);
  check('AT-3b. EL PEDIDO NO CAMBIA DE ESTADO: la ingesta jamás lo mueve por sí sola',
    o?.status === 'PENDING_PAYMENT' && !o?.payment?.paidAt && !o?.payment?.comprobanteUrl,
    `status=${o?.status}`);
  check('AT-3c. el candidato se ACUMULA en el pedido pero NO es comprobante vinculado',
    (o?.receiptAttachments?.candidateIds ?? []).includes(r.attachmentId) && (o?.receiptAttachments?.linkedIds ?? []).length === 0 &&
    (o?.receiptAttachments?.statusDrivenBy ?? null) === null,
    `candidatos=${(o?.receiptAttachments?.candidateIds ?? []).length} vinculados=${(o?.receiptAttachments?.linkedIds ?? []).length}`);
  const msgs = await mensajesDe(C.candidato);
  const salida = msgs.filter((m) => m.direction === 'out');
  check('AT-3d. al cliente se le responde SIN prometer que el pago está confirmado',
    salida.some((m) => m.text === MENSAJE_COMPROBANTE_PROPUESTO) && !/confirmad|pagado/i.test(MENSAJE_COMPROBANTE_PROPUESTO),
    `salidas=${salida.length}: ${JSON.stringify(salida.map((m) => (m.text ?? '').slice(0, 28)))}`);
  check('AT-3e. no hay handoff ni takeover: proponer un candidato no saca al bot del chat',
    !(await db.doc(`tenants/${T}/handoffs/${ordenCandidato}`).get()).exists &&
    (await sessionDoc(C.candidato))?.context?.humanTakeover !== true);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-4. Acción HUMANA ⇒ payment_receipt_linked + PENDING_VERIFICATION. NUNCA PAID.
// ═══════════════════════════════════════════════════════════════════════════
{
  const { result, err } = await call('attachmentMarkAsReceipt', seller, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  const doc = await attachmentDoc(adjuntoCandidato);
  const o = await orderDoc(ordenCandidato);
  check('AT-4. un SELLER marca el adjunto: queda payment_receipt_linked con firma humana',
    result?.ok === true && err === null && doc?.classification?.value === 'payment_receipt_linked' &&
    doc?.classification?.source === 'human' && !!doc?.classification?.by,
    `err=${err} class=${doc?.classification?.value}/${doc?.classification?.source}`);
  check('AT-4b. el pedido llega hasta PENDING_VERIFICATION y NUNCA a PAID (el pago no se confirmó)',
    result?.status === 'PENDING_VERIFICATION' && o?.status === 'PENDING_VERIFICATION' && !o?.payment?.paidAt,
    `status=${o?.status} paidAt=${o?.payment?.paidAt ? 'sí' : 'no'}`);
  check('AT-4c. queda registrado QUÉ adjunto sostiene el estado (sin eso, desmarcar sería adivinar)',
    o?.receiptAttachments?.statusDrivenBy === adjuntoCandidato && (o?.receiptAttachments?.linkedIds ?? []).includes(adjuntoCandidato),
    `drivenBy=${o?.receiptAttachments?.statusDrivenBy === adjuntoCandidato}`);
  const audits = (await auditsDe('order.receipt_marked')).filter((a) => a.targetId === ordenCandidato);
  check('AT-4d. auditoría con el rol real y `paymentConfirmed:false` explícito',
    audits.length === 1 && audits[0].actorRole === 'SELLER' && audits[0].metadata?.paymentConfirmed === false,
    `audits=${audits.length} rol=${audits[0]?.actorRole}`);
  const repetido = await call('attachmentMarkAsReceipt', seller, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  const audits2 = (await auditsDe('order.receipt_marked')).filter((a) => a.targetId === ordenCandidato);
  check('AT-4e. marcar dos veces es IDEMPOTENTE: mismo estado, sin auditoría duplicada',
    repetido.result?.ok === true && repetido.result?.alreadyMarked === true && audits2.length === 1,
    `already=${repetido.result?.alreadyMarked} audits=${audits2.length}`);
  const viewer = await call('attachmentMarkAsReceipt', admin, { attachmentId: adjuntoCandidato, orderId: ordenCandidato, tenantId: T });
  check('AT-4f. PLATFORM_ADMIN no decide qué es un comprobante de un negocio ajeno',
    viewer.err === 'PERMISSION_DENIED', `err=${viewer.err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-5. Desmarcar LEGAL: el pedido vuelve a PENDING_PAYMENT y el archivo se PRESERVA.
// ═══════════════════════════════════════════════════════════════════════════
{
  const orderId = await mkOrder(C.desmarca);
  await setSesion(C.desmarca, { state: 'AWAITING_PAYMENT', context: { pendingOrderId: orderId } });
  const r = await mandarArchivo(C.desmarca, { mediaId: 'MEDIA-AT-5' });
  await esperarClasificacion(r.attachmentId, 'payment_receipt_candidate');
  await call('attachmentMarkAsReceipt', owner, { attachmentId: r.attachmentId, orderId });
  const { result, err } = await call('attachmentUnmarkReceipt', owner, { attachmentId: r.attachmentId, orderId });
  const doc = await attachmentDoc(r.attachmentId);
  const o = await orderDoc(orderId);
  const [existe] = await bucket.file(buildAttachmentStoragePath(T, r.attachmentId)).exists();
  check('AT-5. desmarcar devuelve el pedido a PENDING_PAYMENT (nunca a otro estado)',
    result?.ok === true && result?.reverted === true && o?.status === 'PENDING_PAYMENT' &&
    (o?.receiptAttachments?.statusDrivenBy ?? null) === null,
    `err=${err} status=${o?.status}`);
  check('AT-5b. el archivo se PRESERVA como medio normal: desmarcar quita significado, no evidencia',
    doc?.classification?.value === 'generic_media' && doc?.classification?.source === 'human' &&
    doc?.orderCandidateId === null && doc?.ingestState === 'stored' && existe,
    `class=${doc?.classification?.value} archivo=${existe}`);
  const audits = (await auditsDe('order.receipt_unmarked')).filter((a) => a.targetId === orderId);
  check('AT-5c. queda auditoría del desmarcado (quién y con qué resultado)',
    audits.length === 1 && audits[0].metadata?.reverted === true, `audits=${audits.length}`);
  const otraVez = await call('attachmentUnmarkReceipt', owner, { attachmentId: r.attachmentId, orderId });
  check('AT-5d. desmarcar lo ya desmarcado se RECHAZA con motivo (no es un no-op silencioso)',
    otraVez.err === 'FAILED_PRECONDITION' && /no está marcado/i.test(String(otraVez.errMsg ?? '')),
    `err=${otraVez.err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-6. Desmarcar con el pedido PAID ⇒ RECHAZADO (no se toca evidencia de un pago confirmado).
// ═══════════════════════════════════════════════════════════════════════════
let ordenPagada = null;
let adjuntoPagado = null;
{
  ordenPagada = await mkOrder(C.desmarcaPaid);
  await setSesion(C.desmarcaPaid, { state: 'AWAITING_PAYMENT', context: { pendingOrderId: ordenPagada } });
  const r = await mandarArchivo(C.desmarcaPaid, { mediaId: 'MEDIA-AT-6' });
  adjuntoPagado = r.attachmentId;
  await esperarClasificacion(r.attachmentId, 'payment_receipt_candidate');
  await call('attachmentMarkAsReceipt', seller, { attachmentId: r.attachmentId, orderId: ordenPagada });
  // El ÚNICO camino a PAID: el callable humano de ORDER-1 (confirmPayment). Control positivo.
  const confirmado = await call('orderUpdateStatus', seller, { orderId: ordenPagada, to: 'PAID' });
  const oPagada = await orderDoc(ordenPagada);
  check('AT-6. el pago se confirma SOLO por el callable de ORDER-1 (control positivo del camino real)',
    confirmado.result?.ok === true && oPagada?.status === 'PAID' && !!oPagada?.payment?.paidAt,
    `status=${oPagada?.status}`);
  const desmarcado = await call('attachmentUnmarkReceipt', seller, { attachmentId: r.attachmentId, orderId: ordenPagada });
  const doc = await attachmentDoc(r.attachmentId);
  const o = await orderDoc(ordenPagada);
  check('AT-6b. con el pedido PAID el desmarcado se RECHAZA y nada cambia',
    desmarcado.err === 'FAILED_PRECONDITION' && /ya está pagado/i.test(String(desmarcado.errMsg ?? '')) &&
    doc?.classification?.value === 'payment_receipt_linked' && o?.status === 'PAID',
    `err=${desmarcado.err} class=${doc?.classification?.value}`);
  const remarcado = await call('attachmentMarkAsReceipt', seller, { attachmentId: r.attachmentId, orderId: ordenPagada });
  check('AT-6c. y tampoco se puede re-marcar sobre un pedido pagado',
    remarcado.err === 'FAILED_PRECONDITION', `err=${remarcado.err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-7. Pedido de OTRO cliente ⇒ rechazado por el gate Y por la mano humana.
//       El `pendingOrderId` de la sesión NO se cree: se valida contra quien envía.
// ═══════════════════════════════════════════════════════════════════════════
{
  const ordenAjena = await mkOrder(C.duenoReal);
  // Sesión CORRUPTA a propósito: apunta al pedido de otra persona (el bug original).
  await setSesion(C.ajeno, { state: 'AWAITING_PAYMENT', context: { pendingOrderId: ordenAjena } });
  const r = await mandarArchivo(C.ajeno, { mediaId: 'MEDIA-AT-7' });
  const doc = await esperarClasificacion(r.attachmentId, 'generic_media');
  const o = await orderDoc(ordenAjena);
  check('AT-7. el puntero de sesión que apunta al pedido de OTRO cliente no propone nada',
    doc?.classification?.value === 'generic_media' && doc?.orderCandidateId === null &&
    (o?.receiptAttachments?.candidateIds ?? []).length === 0 && o?.status === 'PENDING_PAYMENT',
    `class=${doc?.classification?.value} candidatos=${(o?.receiptAttachments?.candidateIds ?? []).length}`);
  const marcado = await call('attachmentMarkAsReceipt', seller, { attachmentId: r.attachmentId, orderId: ordenAjena });
  check('AT-7b. y una persona autorizada TAMPOCO puede vincularlo al pedido de otro',
    marcado.err === 'FAILED_PRECONDITION' && /otro cliente/i.test(String(marcado.errMsg ?? '')) &&
    (await orderDoc(ordenAjena))?.status === 'PENDING_PAYMENT',
    `err=${marcado.err} msg=${String(marcado.errMsg ?? '').slice(0, 50)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-8. Pedidos AMBIGUOS: cero elección automática.
// ═══════════════════════════════════════════════════════════════════════════
{
  const a = await mkOrder(C.ambiguo);
  const b = await mkOrder(C.ambiguo);
  // Contexto declarado SIN puntero: exactamente el caso en que hay que abstenerse.
  await setSesion(C.ambiguo, { state: 'AWAITING_PAYMENT', context: { pendingOrderId: null } });
  const r = await mandarArchivo(C.ambiguo, { mediaId: 'MEDIA-AT-8' });
  const doc = await esperarClasificacion(r.attachmentId, 'generic_media');
  const oa = await orderDoc(a);
  const ob = await orderDoc(b);
  check('AT-8. dos pedidos admisibles ⇒ el gate NO elige: el adjunto queda como medio normal',
    doc?.classification?.value === 'generic_media' && doc?.orderCandidateId === null,
    `class=${doc?.classification?.value} candidato=${doc?.orderCandidateId}`);
  check('AT-8b. NINGUNO de los dos pedidos se movió ni recibió candidatos',
    oa?.status === 'PENDING_PAYMENT' && ob?.status === 'PENDING_PAYMENT' &&
    (oa?.receiptAttachments?.candidateIds ?? []).length === 0 && (ob?.receiptAttachments?.candidateIds ?? []).length === 0,
    `a=${oa?.status} b=${ob?.status}`);
  const marcado = await call('attachmentMarkAsReceipt', seller, { attachmentId: r.attachmentId, orderId: a });
  check('AT-8c. la ambigüedad la resuelve una PERSONA: marcar a mano sí funciona y llega a verificación',
    marcado.result?.ok === true && marcado.result?.status === 'PENDING_VERIFICATION' &&
    (await orderDoc(b))?.status === 'PENDING_PAYMENT',
    `status=${marcado.result?.status}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-9. Segunda imagen: ACUMULA, no reemplaza (antes quedaba huérfana).
// ═══════════════════════════════════════════════════════════════════════════
{
  const orderId = await mkOrder(C.acumula);
  await setSesion(C.acumula, { state: 'AWAITING_PAYMENT', context: { pendingOrderId: orderId } });
  const r1 = await mandarArchivo(C.acumula, { mediaId: 'MEDIA-AT-9A' });
  await esperarClasificacion(r1.attachmentId, 'payment_receipt_candidate');
  const r2 = await mandarArchivo(C.acumula, { mediaId: 'MEDIA-AT-9B' });
  const doc2 = await esperarClasificacion(r2.attachmentId, 'payment_receipt_candidate');
  const doc1 = await attachmentDoc(r1.attachmentId);
  const o = await orderDoc(orderId);
  const candidatos = o?.receiptAttachments?.candidateIds ?? [];
  check('AT-9. el segundo envío ACUMULA: los dos adjuntos quedan propuestos sobre el mismo pedido',
    candidatos.length === 2 && candidatos.includes(r1.attachmentId) && candidatos.includes(r2.attachmentId) &&
    doc1?.classification?.value === 'payment_receipt_candidate' && doc2?.classification?.value === 'payment_receipt_candidate',
    `candidatos=${candidatos.length}`);
  check('AT-9b. y el pedido SIGUE sin moverse por más archivos que lleguen',
    o?.status === 'PENDING_PAYMENT' && (o?.receiptAttachments?.linkedIds ?? []).length === 0,
    `status=${o?.status}`);
  const [e1] = await bucket.file(buildAttachmentStoragePath(T, r1.attachmentId)).exists();
  const [e2] = await bucket.file(buildAttachmentStoragePath(T, r2.attachmentId)).exists();
  check('AT-9c. los DOS archivos existen: el segundo no pisó al primero en Storage',
    e1 && e2 && r1.attachmentId !== r2.attachmentId, `a=${e1} b=${e2}`);
  const marcado = await call('attachmentMarkAsReceipt', seller, { attachmentId: r2.attachmentId, orderId });
  const otro = await call('attachmentUnmarkReceipt', seller, { attachmentId: r1.attachmentId, orderId });
  check('AT-9d. marcar UNO de los dos no arrastra al otro, y desmarcar el que no manda se rechaza',
    marcado.result?.status === 'PENDING_VERIFICATION' &&
    (await attachmentDoc(r1.attachmentId))?.classification?.value === 'payment_receipt_candidate' &&
    otro.err === 'FAILED_PRECONDITION',
    `otro=${otro.err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-10. Reintento del webhook: sin duplicados en ninguna de las dos capas.
// ═══════════════════════════════════════════════════════════════════════════
{
  const mid = nuevoMid('retry');
  const r = await mandarArchivo(C.reintento, { mediaId: 'MEDIA-AT-10', caption: 'uno solo', mid });
  const antes = await attachmentDoc(r.attachmentId);
  // Capa 1: el inbox deduplica por messageId.
  const repost = await postWebhook(C.reintento, mid, { type: 'image', image: { id: 'MEDIA-AT-10', mime_type: 'image/jpeg', caption: 'uno solo' } });
  check('AT-10. el mismo wamid dos veces se deduplica en el inbox (0 escritos, 1 duplicado)',
    repost.body?.written === 0 && repost.body?.duplicates === 1, `written=${repost.body?.written} dup=${repost.body?.duplicates}`);
  // Capa 2: el reintento que SÍ vuelve a llegar al trigger (el evento del inbox ya rotó/expiró).
  const inboxId = `whatsapp_${mid.replace(/[^\w.:=+-]/g, '_').slice(0, 256)}`;
  await db.doc(`metaWebhookInbox/${inboxId}`).delete();
  await postWebhook(C.reintento, mid, { type: 'image', image: { id: 'MEDIA-AT-10', mime_type: 'image/jpeg', caption: 'uno solo' } });
  await esperarEvento(mid);
  await sleep(2000);
  const docs = await attachmentsDe(C.reintento);
  const despues = await attachmentDoc(r.attachmentId);
  const msgs = await mensajesDe(C.reintento);
  check('AT-10b. reprocesado de verdad: sigue habiendo UN adjunto y UNA burbuja (create() falla, no duplica)',
    docs.length === 1 && msgs.filter((m) => m.direction === 'in').length === 1 &&
    (msgs[0].attachmentIds ?? []).length === 1,
    `adjuntos=${docs.length} burbujasIn=${msgs.filter((m) => m.direction === 'in').length}`);
  check('AT-10c. tampoco se volvieron a bajar los bytes: el documento quedó intacto',
    despues?.updatedAt?.toMillis?.() === antes?.updatedAt?.toMillis?.() && despues?.checksum === antes?.checksum,
    `updatedAt igual=${despues?.updatedAt?.toMillis?.() === antes?.updatedAt?.toMillis?.()}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-11. PDF: se guarda y se ve (antes se descartaba EN SILENCIO — defecto #3).
// ═══════════════════════════════════════════════════════════════════════════
let adjuntoPdf = null;
{
  const r = await mandarArchivo(C.pdf, {
    kind: 'document', mediaId: 'MEDIA-AT-11', mime: 'application/pdf',
    filename: 'transferencia banco.pdf', caption: 'te mando el pdf',
  });
  adjuntoPdf = r.attachmentId;
  const doc = await esperarClasificacion(r.attachmentId, 'generic_media');
  const [existe] = await bucket.file(buildAttachmentStoragePath(T, r.attachmentId)).exists();
  const msgs = await mensajesDe(C.pdf);
  check('AT-11. un PDF entrante se guarda, se verifica y queda VISIBLE en el chat',
    doc?.ingestState === 'stored' && doc?.class === 'document' && doc?.mime?.verified === 'application/pdf' && existe &&
    msgs.some((m) => (m.attachmentIds ?? []).includes(r.attachmentId)),
    `ingest=${doc?.ingestState} class=${doc?.class} mime=${doc?.mime?.verified}`);
  check('AT-11b. el nombre original queda SANEADO y decorativo: no define el tipo ni la ruta',
    typeof doc?.filename === 'string' && !doc.filename.includes('/') &&
    buildAttachmentStoragePath(T, r.attachmentId).endsWith(r.attachmentId),
    `filename=${JSON.stringify(doc?.filename)}`);
  // La DECISIÓN de servirlo como descarga se toma en el emisor real; acá se lee lo que llega al
  // firmante, que es más fuerte que leer el campo de la respuesta: verifica que el
  // Content-Disposition entre efectivamente en la firma y no sea un adorno del payload.
  let firmadoPdf = null;
  const emitidoPdf = await issueAttachmentViewUrl(
    T, { kind: 'attachment', attachmentId: r.attachmentId },
    { ...defaultAttachmentViewDeps, signUrl: async (req) => { firmadoPdf = req; return 'https://firmada.invalida/x'; } },
  );
  check('AT-11c. el visor lo FIRMA como DESCARGA (`attachment`), nunca inline: un PDF inline se renderiza',
    emitidoPdf.ok === true && firmadoPdf?.disposition === 'attachment' &&
    firmadoPdf?.contentType === 'application/pdf' && firmadoPdf?.filename?.endsWith('.pdf'),
    `disposition=${firmadoPdf?.disposition} tipo=${firmadoPdf?.contentType} nombre=${firmadoPdf?.filename}`);
  // Y el contrapeso en el emulador: aunque el objeto TENGA token de descarga —o sea, aunque emitir
  // fuera trivialmente posible— el enlace NO se emite, porque el endpoint `?alt=media` no puede
  // forzar la descarga y serviría el PDF inline con el origen del bucket. Antes que romper esa
  // regla, no se emite nada. El control positivo de que el token alcanza es AT-17f (misma
  // maquinaria, imagen inline): si esto fallara por falta de token, aquel también fallaría.
  await sembrarTokenDeDescarga(buildAttachmentStoragePath(T, r.attachmentId));
  const { result, err } = await call('attachmentGetViewUrl', owner, { attachmentId: r.attachmentId });
  check('AT-11d. el emulador NO puede forzar la descarga ⇒ prefiere no emitir antes que servirlo inline',
    result?.ok !== true && err === 'INTERNAL', `ok=${result?.ok} err=${err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-12/13/14. Rechazos y fallos de descarga contra el CÓDIGO REAL (transporte inyectado).
// ═══════════════════════════════════════════════════════════════════════════
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PDF_HEAD = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'utf8');
const respuestaStream = (chunks) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } }), { status: 200 });
/** `fetch` FALSO: primera llamada = metadata de Graph, segunda = contenido. Cero red. */
const fetchFalso = (meta, contenido) => {
  let n = 0;
  return async () => {
    n += 1;
    if (n === 1) return new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } });
    return typeof contenido === 'function' ? contenido() : contenido;
  };
};
const URL_FIRMADA_FALSA = 'https://lookaside.fbsbx.com/whatsapp/1234567890?token=SECRETO-DE-META-abc123';
const adjuntoEntrante = (mediaId, over = {}) => ({ kind: 'image', mediaId, declaredMime: 'image/jpeg', filename: null, caption: '', sha256: null, ...over });
/** Ingesta REAL con una descarga que devuelve el rechazo REAL del mediaClient. */
const ingestarCon = (customerId, mediaId, resultadoDescarga, over = {}) =>
  ingestInboundAttachment(
    { tenantId: T, customerId, channel: 'whatsapp', providerMessageId: `wamid.INPROC-${mediaId}`, attachment: adjuntoEntrante(mediaId, over) },
    { download: async () => resultadoDescarga, saveBytes: async () => { throw new Error('no debería guardarse nada'); } },
  );

{
  // ── AT-12. El MIME declarado MIENTE (declara JPEG, el contenido es PDF) ──
  const descarga = await downloadWhatsappAttachment({
    mediaId: 'MEDIA-AT-12', accessToken: 'token-falso', retries: 0, retryDelayMs: 0,
    fetchImpl: fetchFalso({ url: URL_FIRMADA_FALSA, mime_type: 'image/jpeg', file_size: PDF_HEAD.length }, () => respuestaStream([PDF_HEAD])),
  });
  check('AT-12. el módulo REAL rechaza el MIME declarado que no coincide con los magic bytes',
    descarga.ok === false && descarga.reason === 'mime_mismatch', `reason=${descarga.reason}`);
  const res = await ingestarCon(C.mimeFalso, 'MEDIA-AT-12', descarga);
  const doc = await attachmentDoc(res.attachmentId);
  const [existe] = await bucket.file(buildAttachmentStoragePath(T, res.attachmentId)).exists();
  check('AT-12b. la ingesta lo cierra `rejected` en los DOS ejes y NADA llega a Storage',
    doc?.ingestState === 'rejected' && doc?.classification?.value === 'rejected' &&
    doc?.storage?.path === null && existe === false,
    `ingest=${doc?.ingestState} class=${doc?.classification?.value} archivo=${existe}`);
  check('AT-12c. el rechazo NO bloquea la conversación: se responde al cliente y queda rastro en el chat',
    res.reply === ATTACHMENT_REPLIES.unsupported_type &&
    (await mensajesDe(C.mimeFalso)).some((m) => (m.attachmentIds ?? []).includes(res.attachmentId)),
    `reply=${JSON.stringify(res.reply.slice(0, 30))}`);
  check('AT-12d. `lastError` queda SANEADO: sin URL firmada, sin token, sin el mediaId',
    typeof doc?.lastError === 'string' && doc.lastError.length > 0 && !/https?:\/\//.test(doc.lastError) &&
    !doc.lastError.includes('SECRETO-DE-META') && !doc.lastError.includes('MEDIA-AT-12'),
    `lastError=${JSON.stringify(doc?.lastError)}`);
}

{
  // ── AT-13. Oversize: se corta DURANTE el stream, no después de materializarlo ──
  const grande = Buffer.alloc(4096, 0x41);
  const descarga = await downloadWhatsappAttachment({
    mediaId: 'MEDIA-AT-13', accessToken: 'token-falso', maxBytes: 1024, retries: 0, retryDelayMs: 0,
    fetchImpl: fetchFalso({ url: URL_FIRMADA_FALSA, mime_type: 'image/jpeg' }, () => respuestaStream([JPEG_HEAD, grande])),
  });
  const declaradoGrande = await downloadWhatsappAttachment({
    mediaId: 'MEDIA-AT-13B', accessToken: 'token-falso', maxBytes: 1024, retries: 0, retryDelayMs: 0,
    fetchImpl: fetchFalso({ url: URL_FIRMADA_FALSA, mime_type: 'image/jpeg', file_size: 99_999_999 }, () => respuestaStream([JPEG_HEAD])),
  });
  check('AT-13. el tope de bytes corta el stream Y descarta temprano por el tamaño declarado',
    descarga.ok === false && descarga.reason === 'too_large' && declaradoGrande.ok === false && declaradoGrande.reason === 'too_large',
    `stream=${descarga.reason} declarado=${declaradoGrande.reason}`);
  const res = await ingestarCon(C.oversize, 'MEDIA-AT-13', descarga);
  const doc = await attachmentDoc(res.attachmentId);
  const [existe] = await bucket.file(buildAttachmentStoragePath(T, res.attachmentId)).exists();
  check('AT-13b. el adjunto queda `rejected` sin bytes y el cliente recibe la indicación de reenviar liviano',
    doc?.ingestState === 'rejected' && doc?.classification?.value === 'rejected' && existe === false &&
    res.reply === ATTACHMENT_REPLIES.too_large,
    `ingest=${doc?.ingestState} reply=${JSON.stringify(res.reply.slice(0, 24))}`);
  const marcado = await call('attachmentMarkAsReceipt', seller, { attachmentId: res.attachmentId, orderId: ordenCandidato });
  check('AT-13c. un archivo rechazado no puede convertirse en comprobante ni a mano',
    marcado.err === 'FAILED_PRECONDITION', `err=${marcado.err}`);
}

{
  // ── AT-14. Descarga fallida: RECUPERABLE (no se descarta la clasificación) ──
  const descarga = await downloadWhatsappAttachment({
    mediaId: 'MEDIA-AT-14', accessToken: 'token-falso', retries: 1, retryDelayMs: 0,
    fetchImpl: async () => new Response('boom', { status: 500 }),
  });
  check('AT-14. Graph caído (5xx con reintentos agotados) ⇒ `fetch_failed`, no un rechazo del archivo',
    descarga.ok === false && descarga.reason === 'fetch_failed', `reason=${descarga.reason}`);
  const res = await ingestarCon(C.descargaFallida, 'MEDIA-AT-14', descarga);
  const doc = await attachmentDoc(res.attachmentId);
  check('AT-14b. queda `download_failed` con la clasificación ABIERTA: es infra recuperable, no un archivo inválido',
    doc?.ingestState === 'download_failed' && doc?.classification?.value === 'unclassified' &&
    typeof doc?.lastError === 'string' && doc.lastError.length > 0,
    `ingest=${doc?.ingestState} class=${doc?.classification?.value}`);
  check('AT-14c. se le pide al cliente que lo reenvíe y el fallo queda visible en el chat',
    res.reply === ATTACHMENT_REPLIES.download_failed &&
    (await mensajesDe(C.descargaFallida)).some((m) => (m.attachmentIds ?? []).includes(res.attachmentId)),
    `reply=${JSON.stringify(res.reply.slice(0, 30))}`);
  const { err, errMsg } = await call('attachmentGetViewUrl', owner, { attachmentId: res.attachmentId });
  check('AT-14d. el visor lo dice honestamente en vez de firmar una URL a un archivo que no existe',
    err === 'FAILED_PRECONDITION' && /todavía no está disponible/i.test(String(errMsg ?? '')), `err=${err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-15. Callable ANÓNIMA denegada (los bytes de un cliente no salen sin sesión).
// ═══════════════════════════════════════════════════════════════════════════
{
  const ver = await call('attachmentGetViewUrl', null, { attachmentId: adjuntoCandidato });
  const marcar = await call('attachmentMarkAsReceipt', null, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  const desmarcar = await call('attachmentUnmarkReceipt', null, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  check('AT-15. sin sesión: ni ver el archivo, ni marcarlo, ni desmarcarlo',
    ver.err === 'UNAUTHENTICATED' && marcar.err === 'UNAUTHENTICATED' && desmarcar.err === 'UNAUTHENTICATED',
    `ver=${ver.err} marcar=${marcar.err} desmarcar=${desmarcar.err}`);
  check('AT-15b. y la denegación no filtra ninguna URL ni ruta en el mensaje de error',
    !JSON.stringify([ver, marcar, desmarcar]).includes('tenants/') && !JSON.stringify([ver, marcar, desmarcar]).includes('http'),
    `msg=${String(ver.errMsg ?? '').slice(0, 40)}`);
  const anon = await fetch(`${FS}/tenants/${T}/attachments/${adjuntoCandidato}`);
  check('AT-15c. el cliente tampoco lee la metadata directo de Firestore sin autenticar',
    anon.status === 403 || anon.status === 401, `status=${anon.status}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-16. Cross-tenant denegado (el tenant sale SIEMPRE de los claims).
// ═══════════════════════════════════════════════════════════════════════════
{
  const verOtroTenant = await call('attachmentGetViewUrl', ownerBoutique, { attachmentId: adjuntoCandidato, tenantId: T });
  check('AT-16. el dueño de otra empresa no obtiene el archivo aunque PIDA el tenant ajeno',
    verOtroTenant.err !== null && verOtroTenant.result === undefined, `err=${verOtroTenant.err}`);
  const marcarOtro = await call('attachmentMarkAsReceipt', ownerBoutique, { attachmentId: adjuntoCandidato, orderId: ordenCandidato, tenantId: T });
  check('AT-16b. y tampoco puede marcar: el tenantId pedido solo puede COINCIDIR con el del claim',
    marcarOtro.err === 'PERMISSION_DENIED' && (await attachmentDoc(adjuntoCandidato))?.classification?.value === 'payment_receipt_linked',
    `err=${marcarOtro.err}`);
  const rulesAjeno = await restGet(`tenants/${T}/attachments/${adjuntoCandidato}`, ownerBoutique);
  const rulesPropio = await restGet(`tenants/${T}/attachments/${adjuntoCandidato}`, seller);
  check('AT-16c. las rules cierran la lectura cross-tenant y la abren para el staff propio',
    rulesAjeno === 403 && rulesPropio === 200, `ajeno=${rulesAjeno} propio=${rulesPropio}`);
  const escritura = await restPatch(`tenants/${T}/attachments/${adjuntoCandidato}`, owner, { caption: { stringValue: 'inventado' } });
  check('AT-16d. la ESCRITURA está cerrada incluso para el dueño: un update inventaría un comprobante',
    escritura === 403 && (await attachmentDoc(adjuntoCandidato))?.caption !== 'inventado', `status=${escritura}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-17. URL de vida corta: techo duro, re-emisión y JAMÁS persistida.
// ═══════════════════════════════════════════════════════════════════════════
{
  // El objeto recibe su token PREVIO (ver `sembrarTokenDeDescarga`): es la única forma de que el
  // emulador sirva bytes, y el emisor real solo lo REUTILIZA. El techo temporal, la re-emisión y el
  // "jamás persistida" que siguen son los del código de producción, sin tocar.
  await sembrarTokenDeDescarga(buildAttachmentStoragePath(T, adjuntoCandidato));
  const t0 = Date.now();
  const uno = await call('attachmentGetViewUrl', seller, { attachmentId: adjuntoCandidato });
  const dos = await call('attachmentGetViewUrl', seller, { attachmentId: adjuntoCandidato });
  check('AT-17. el enlace vence en ≤10 min y siempre en el FUTURO (techo duro del emisor)',
    uno.result?.ok === true && uno.result.expiresAt > t0 && uno.result.expiresAt - t0 <= ATTACHMENT_VIEW_URL_MAX_TTL_MS + 2000,
    `ttl=${Math.round(((uno.result?.expiresAt ?? 0) - t0) / 1000)}s techo=${ATTACHMENT_VIEW_URL_MAX_TTL_MS / 1000}s`);
  check('AT-17b. cada pedido RE-EMITE con vencimiento nuevo (no se recicla un enlace viejo)',
    dos.result?.ok === true && dos.result.expiresAt >= uno.result.expiresAt, `uno=${uno.result?.expiresAt} dos=${dos.result?.expiresAt}`);
  // Reloj adelantado un año contra el emisor REAL: si existiera una rama "no vence", el
  // vencimiento entregado al firmante no seguiría al reloj.
  let firmado = null;
  const futuro = Date.now() + 365 * 86_400_000;
  const emitido = await issueAttachmentViewUrl(
    T, { kind: 'attachment', attachmentId: adjuntoCandidato },
    {
      loadAttachment: async () => ({ tenantId: T, storagePath: buildAttachmentStoragePath(T, adjuntoCandidato), ingestState: 'stored', verifiedMime: 'image/jpeg', filename: null, purged: false }),
      loadLegacyComprobanteRef: async () => null,
      fileExists: async () => true,
      signUrl: async (req) => { firmado = req; return 'https://firmada.invalida/x'; },
    },
    futuro,
  );
  check('AT-17c. el vencimiento SIGUE al reloj: nunca hay un enlace perpetuo',
    emitido.ok === true && firmado?.expiresAtMs === futuro + ATTACHMENT_VIEW_URL_MAX_TTL_MS,
    `delta=${firmado ? firmado.expiresAtMs - futuro : 'sin firma'}`);
  const doc = await attachmentDoc(adjuntoCandidato);
  const audits = await auditsDe('attachment.view_url_issued');
  const cuerpo = JSON.stringify({ doc, audits, msgs: await mensajesDe(C.candidato) });
  check('AT-17d. la URL firmada NO se persiste en ningún lado (ni doc, ni auditoría, ni chat)',
    audits.length >= 2 && !cuerpo.includes(uno.result.url) && !cuerpo.includes('alt=media') && !cuerpo.includes('token='),
    `audits=${audits.length}`);
  check('AT-17e. la auditoría registra la emisión SIN la ruta y con vencimiento',
    audits.every((a) => !JSON.stringify(a).includes('tenants/') || a.targetType === 'attachment') &&
    audits.every((a) => typeof a.metadata?.expiresAtMs === 'number'),
    `familias=${JSON.stringify([...new Set(audits.map((a) => a.metadata?.family))])}`);
  const descarga = await fetch(uno.result.url);
  check('AT-17f. el enlace vigente sí entrega los bytes (si no, el techo sería trivialmente cierto)',
    descarga.status === 200 && Number(descarga.headers.get('content-length') ?? 0) > 0, `status=${descarga.status}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-18. Path traversal: por la entrada del callable y por un documento ADULTERADO.
// ═══════════════════════════════════════════════════════════════════════════
{
  const idSucio = await call('attachmentGetViewUrl', owner, { attachmentId: `att_../../${adjuntoCandidato}` });
  const ordenSucia = await call('attachmentGetViewUrl', owner, { orderId: '../../otro-tenant' });
  const ambos = await call('attachmentGetViewUrl', owner, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  const marcarSucio = await call('attachmentMarkAsReceipt', seller, { attachmentId: adjuntoCandidato, orderId: '../../ord_ajena' });
  check('AT-18. ninguna referencia con `..` entra: el path NUNCA viene del cliente',
    idSucio.err === 'INVALID_ARGUMENT' && ordenSucia.err === 'INVALID_ARGUMENT' && marcarSucio.err === 'INVALID_ARGUMENT',
    `id=${idSucio.err} orden=${ordenSucia.err} marcar=${marcarSucio.err}`);
  check('AT-18b. pedir las DOS referencias a la vez se rechaza (no se elige por orden de los `if`)',
    ambos.err === 'INVALID_ARGUMENT', `err=${ambos.err}`);
  // Documento ADULTERADO: el path guardado apunta afuera. Se reverifica contra el tenant.
  // Se adultera el adjunto IMAGEN (no el PDF) porque AT-18d exige que, restaurada la ruta, el
  // archivo vuelva a ABRIR de verdad por el callable: con el PDF esa comprobación sería imposible
  // en el emulador (no puede forzar la descarga, ver AT-11d) y el "vuelve a abrir" quedaría
  // indistinguible de un fallo. El guard de traversal no depende del tipo de archivo.
  const original = (await attachmentDoc(adjuntoCandidato))?.storage?.path ?? null;
  const rutas = [
    `tenants/${T2}/attachments/aa/${adjuntoCandidato}`,
    `tenants/${T}/attachments/../../${T2}/attachments/aa/${adjuntoCandidato}`,
    `tenants/${T}/products/${adjuntoCandidato}`,
  ];
  const denegados = [];
  for (const ruta of rutas) {
    await db.doc(buildAttachmentDocPath(T, adjuntoCandidato)).update({ 'storage.path': ruta });
    const res = await call('attachmentGetViewUrl', owner, { attachmentId: adjuntoCandidato });
    denegados.push(res.err);
  }
  await db.doc(buildAttachmentDocPath(T, adjuntoCandidato)).update({ 'storage.path': original });
  check('AT-18c. un documento ADULTERADO no puede escaparse del tenant ni de la carpeta',
    denegados.every((e) => e === 'PERMISSION_DENIED'), `resultados=${JSON.stringify(denegados)}`);
  const vuelve = await call('attachmentGetViewUrl', owner, { attachmentId: adjuntoCandidato });
  check('AT-18d. restaurada la ruta legítima, el mismo adjunto vuelve a abrir (el guard no rompió nada)',
    vuelve.result?.ok === true, `err=${vuelve.err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-19. Comprobante LEGACY: sigue abriendo con el visor (compatibilidad aditiva).
// ═══════════════════════════════════════════════════════════════════════════
{
  const orderId = await mkOrder(C.legacy, 'PENDING_VERIFICATION');
  const rutaLegacy = `tenants/${T}/orders/${orderId}/comprobantes/pmid-legacy.jpg`;
  await bucket.file(rutaLegacy).save(JPEG_HEAD, { contentType: 'image/jpeg', resumable: false });
  await sembrarTokenDeDescarga(rutaLegacy); // misma razón que en AT-17: el emulador no firma.
  await db.doc(`tenants/${T}/orders/${orderId}`).set({ payment: { comprobanteUrl: rutaLegacy } }, { merge: true });
  const { result, err } = await call('attachmentGetViewUrl', seller, { orderId });
  check('AT-19. el emisor NUEVO abre un comprobante LEGACY sin reescribir historia',
    result?.ok === true && result?.contentType === 'image/jpeg' && result?.disposition === 'inline',
    `err=${err} tipo=${result?.contentType}`);
  const bytes = await fetch(result?.url ?? 'http://127.0.0.1:1/no');
  check('AT-19b. y los bytes salen de verdad por el enlace temporal',
    bytes.status === 200, `status=${bytes.status}`);
  const viejo = await call('orderGetComprobanteViewUrl', seller, { orderId });
  check('AT-19c. el visor histórico de ORDER-1 sigue funcionando en paralelo (nada se rompió)',
    viejo.result?.ok === true || typeof viejo.result?.url === 'string', `err=${viejo.err}`);
  const otroPedido = await call('attachmentGetViewUrl', seller, { orderId: ordenCandidato });
  check('AT-19d. un pedido SIN comprobante legacy no firma nada (no cae al adjunto nuevo por descarte)',
    otroPedido.err === 'FAILED_PRECONDITION', `err=${otroPedido.err}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-20. Texto FALSO "📷 Imagen recibida": no fabrica ningún adjunto.
// ═══════════════════════════════════════════════════════════════════════════
const IA_TRAS_ADJUNTOS = await usoIa();
{
  const antes = (await attachmentsCol().get()).size;
  const mid = nuevoMid('texto');
  await postWebhook(C.textoFalso, mid, { type: 'text', text: { body: '📷 Imagen recibida' } });
  await esperarEvento(mid);
  await sleep(2500);
  const msgs = await mensajesDe(C.textoFalso);
  const entrante = msgs.find((m) => m.text === '📷 Imagen recibida' && m.direction === 'in');
  const despues = (await attachmentsCol().get()).size;
  check('AT-20. escribir "📷 Imagen recibida" a mano NO crea ningún adjunto',
    (await attachmentsDe(C.textoFalso)).length === 0 && despues === antes,
    `adjuntosDelCliente=${(await attachmentsDe(C.textoFalso)).length} total=${antes}→${despues}`);
  check('AT-20b. y el mensaje queda SIN punteros: el panel no puede inferir un archivo desde el texto',
    !!entrante && entrante.hasAttachments !== true && (entrante.attachmentIds ?? []).length === 0,
    `hasAttachments=${entrante?.hasAttachments} punteros=${JSON.stringify(entrante?.attachmentIds ?? [])}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-21. CERO llamadas a IA por el camino de adjuntos (ADR-0016 §9).
// ═══════════════════════════════════════════════════════════════════════════
{
  check('AT-21. ni un token ni un centavo de IA en TODO el camino de adjuntos',
    IA_TRAS_ADJUNTOS.tokens === IA_ANTES.tokens && IA_TRAS_ADJUNTOS.costo === IA_ANTES.costo,
    `tokens ${IA_ANTES.tokens}→${IA_TRAS_ADJUNTOS.tokens} costo ${IA_ANTES.costo}→${IA_TRAS_ADJUNTOS.costo}`);
  // La prueba estructural del §9: el caption puede alimentar las REGLAS (por eso el cliente
  // recibe respuesta), pero no queda como texto de ningún mensaje ⇒ no existe forma de que entre
  // al prompt, ni en el turno del archivo ni en los siguientes (el historial sale de `messages`).
  const docCaption = await attachmentDoc(adjuntoCandidato);
  const msgsCaption = await mensajesDe(C.candidato);
  check('AT-21b. el caption se conserva en el ADJUNTO y jamás como texto de un mensaje',
    docCaption?.caption === 'ahí va el comprobante' &&
    msgsCaption.every((m) => (m.text ?? '') !== 'ahí va el comprobante'),
    `caption=${JSON.stringify(docCaption?.caption)} mensajes=${msgsCaption.length}`);
  const libIngesta = readFileSync(new URL('../lib/meta/attachmentIngest.js', import.meta.url), 'utf8');
  const libGate = readFileSync(new URL('../lib/orders/receiptAttachmentGate.js', import.meta.url), 'utf8');
  check('AT-21c. ni la ingesta ni el gate importan NADA del módulo de IA (ni por transitividad directa)',
    !/from '\.\.\/ai\//.test(libIngesta) && !/from '\.\.\/ai\//.test(libGate) &&
    !/anthropic/i.test(libIngesta) && !/anthropic/i.test(libGate));
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-22. CERO caminos a PAID desde el mundo de los adjuntos.
// ═══════════════════════════════════════════════════════════════════════════
{
  const pedidos = [];
  for (const { id } of createdOrders) pedidos.push({ id, doc: await orderDoc(id) });
  const pagados = pedidos.filter((p) => p.doc?.status === 'PAID');
  check('AT-22. de todos los pedidos del programa, el ÚNICO PAID es el que confirmó una persona por ORDER-1',
    pagados.length === 1 && pagados[0].id === ordenPagada,
    `pagados=${pagados.length} (${pagados.map((p) => p.doc?.status).join(',')})`);
  const marcarAPagar = await call('attachmentMarkAsReceipt', seller, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  check('AT-22b. re-marcar un adjunto sobre un pedido en verificación no lo empuja a PAID',
    marcarAPagar.result?.status === 'PENDING_VERIFICATION' && (await orderDoc(ordenCandidato))?.status === 'PENDING_VERIFICATION',
    `status=${marcarAPagar.result?.status}`);
  // Estructural: en el mundo de los adjuntos NADIE escribe el literal 'PAID'. Lo pagado se
  // consulta por `isPaidStatus`/`UNPAID_STATUSES`, que son de solo lectura.
  const modulos = [
    'meta/attachmentIngest.js', 'meta/attachmentGate.js', 'orders/receiptGate.js',
    'orders/receiptStore.js', 'orders/receiptAttachmentGate.js',
    'functions/attachments/attachmentCallables.js', 'functions/attachments/mediaViewCallable.js',
  ];
  const conPaid = modulos.filter((m) => /(^|[^_A-Z])'PAID'/.test(readFileSync(new URL(`../lib/${m}`, import.meta.url), 'utf8')));
  check('AT-22c. ningún módulo de adjuntos menciona siquiera el literal `PAID` (se lee por helper)',
    conPaid.length === 0, `con PAID=${JSON.stringify(conPaid)}`);
  const linked = await attachmentDoc(adjuntoPagado);
  check('AT-22d. y el adjunto del pedido ya pagado quedó como evidencia intacta (nunca se borra)',
    linked?.classification?.value === 'payment_receipt_linked' && linked?.purgedAt === null &&
    (await bucket.file(buildAttachmentStoragePath(T, adjuntoPagado)).exists())[0] === true,
    `class=${linked?.classification?.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// AT-23 · ROLLOUT EN DOS NIVELES, FAIL-CLOSED (ADR-0016 §10)
// Va al final a propósito: apaga los flags, así que cualquier check posterior mediría el sistema
// apagado. Es el ÚNICO bloque que prueba el estado REAL del día del deploy —ningún tenant tiene
// estos documentos— y por eso no puede faltar: sin él, el E2E entero solo sabe describir la
// fundación encendida.
// ═══════════════════════════════════════════════════════════════════════════
{
  const iaAntesDeApagar = await usoIa();

  // ── Nivel B apagado (la ingesta sigue encendida) ──────────────────────────
  await db.doc(`tenants/${T}/config/receiptGate`).set({ enabled: false });
  const ordenB = await mkOrder(C.rolloutGateOff);
  await setSesion(C.rolloutGateOff, { pendingOrderId: ordenB });
  const rB = await mandarArchivo(C.rolloutGateOff, { mediaId: 'MEDIA-AT-23B' });
  const docB = await esperarClasificacion(rB.attachmentId, 'generic_media');
  storagePathsCreados.push(buildAttachmentStoragePath(T, rB.attachmentId));
  check('AT-23a. nivel B apagado: el archivo SÍ se guarda, pero queda `generic_media`',
    docB?.ingestState === 'stored' && docB?.classification?.value === 'generic_media' && docB?.orderCandidateId === null,
    `ingest=${docB?.ingestState} class=${docB?.classification?.value} candidato=${docB?.orderCandidateId}`);
  const pedidoB = await orderDoc(ordenB);
  const avisosB = await db.collection(`tenants/${T}/notifications`).where('type', '==', 'handoff_receipt_candidate').get();
  check('AT-23b. sin candidato no hay campana ni el pedido se toca (§10 + §11)',
    (pedidoB?.receiptAttachments?.candidateIds ?? []).length === 0 && pedidoB?.status === 'PENDING_PAYMENT' &&
    avisosB.docs.every((d) => d.data().customerId !== C.rolloutGateOff),
    `candidatos=${JSON.stringify(pedidoB?.receiptAttachments?.candidateIds ?? [])} status=${pedidoB?.status} avisos=${avisosB.size}`);
  // El genérico invita a escribir *pagar* para vincular el archivo: con el nivel B apagado esa
  // vinculación no existe por ningún camino, así que ese texto sería una mentira y un bucle.
  const msgsB = await mensajesDe(C.rolloutGateOff);
  const salidaB = msgsB.filter((m) => m.direction === 'out').map((m) => (m.text ?? '').toLowerCase());
  check('AT-23c. al cliente se le responde, sin prometer una vinculación imposible',
    salidaB.length > 0 && salidaB.every((t) => !t.includes('*pagar*')),
    `salidas=${salidaB.length}`);
  const marcarOff = await call('attachmentMarkAsReceipt', seller, { attachmentId: rB.attachmentId, orderId: ordenB });
  check('AT-23d. `attachmentMarkAsReceipt` RECHAZA con el nivel B apagado',
    marcarOff.err === 'FAILED_PRECONDITION' && (await orderDoc(ordenB))?.status === 'PENDING_PAYMENT',
    `err=${marcarOff.err ?? 'ninguno'} status=${(await orderDoc(ordenB))?.status}`);
  // La asimetría del §10: apagar una función no puede dejar atrapada una decisión humana ya
  // tomada. El adjunto canónico quedó marcado antes, con el gate encendido.
  const desmarcarOff = await call('attachmentUnmarkReceipt', seller, { attachmentId: adjuntoCandidato, orderId: ordenCandidato });
  check('AT-23e. pero `attachmentUnmarkReceipt` SIGUE disponible con el flag apagado',
    desmarcarOff.err === null && (await attachmentDoc(adjuntoCandidato))?.classification?.value === 'generic_media',
    `err=${desmarcarOff.err ?? 'ninguno'} class=${(await attachmentDoc(adjuntoCandidato))?.classification?.value}`);
  const marcadoPrevio = await attachmentDoc(adjuntoPagado);
  check('AT-23f. y apagar el nivel B no oculta ni borra nada de lo ya guardado',
    marcadoPrevio?.classification?.value === 'payment_receipt_linked' && marcadoPrevio?.purgedAt === null &&
    (await bucket.file(buildAttachmentStoragePath(T, adjuntoPagado)).exists())[0] === true,
    `class=${marcadoPrevio?.classification?.value}`);

  // ── Nivel A apagado: ni un byte ───────────────────────────────────────────
  await db.doc(`tenants/${T}/config/attachments`).set({ ingest: { enabled: false } }, { merge: true });
  const ordenA = await mkOrder(C.rolloutIngestOff);
  await setSesion(C.rolloutIngestOff, { pendingOrderId: ordenA });
  const rA = await mandarArchivo(C.rolloutIngestOff, { mediaId: 'MEDIA-AT-23A', caption: 'ya te pagué, confirmame' });
  const docA = await attachmentDoc(rA.attachmentId);
  const [existeA] = await bucket.file(buildAttachmentStoragePath(T, rA.attachmentId)).exists();
  check('AT-23g. nivel A apagado: CERO documento de adjunto y CERO bytes en Storage',
    rA.status === 200 && docA === null && existeA === false,
    `status=${rA.status} doc=${docA === null ? 'no' : 'sí'} archivo=${existeA}`);
  const msgsA = await mensajesDe(C.rolloutIngestOff);
  check('AT-23h. pero el inbound NO desaparece: queda visible y el cliente recibe respuesta',
    msgsA.some((m) => m.direction === 'in') && msgsA.some((m) => m.direction === 'out' && (m.text ?? '').trim() !== ''),
    `entradas=${msgsA.filter((m) => m.direction === 'in').length} salidas=${msgsA.filter((m) => m.direction === 'out').length}`);
  // §10 es taxativo: «sin caption a la IA, sin tocar pedidos, sin handoff». El caption de este
  // envío ("ya te pagué, confirmame") es justo el que dispararía el camino legacy si reviviera.
  const iaTrasApagar = await usoIa();
  check('AT-23i. el caption no queda en el historial ni abre turno del motor (no llega a la IA)',
    msgsA.every((m) => !(m.text ?? '').includes('ya te pagué')) &&
    iaTrasApagar.tokens === iaAntesDeApagar.tokens && iaTrasApagar.costo === iaAntesDeApagar.costo,
    `tokens ${iaAntesDeApagar.tokens}→${iaTrasApagar.tokens}`);
  const pedidoA = await orderDoc(ordenA);
  const sesionA = await sessionDoc(C.rolloutIngestOff);
  check('AT-23j. y CERO mutación comercial: el pedido no se mueve, sin handoff y sin takeover',
    pedidoA?.status === 'PENDING_PAYMENT' && sesionA?.context?.humanTakeover !== true &&
    !(await db.doc(`tenants/${T}/handoffs/${ordenA}`).get()).exists,
    `status=${pedidoA?.status} takeover=${sesionA?.context?.humanTakeover}`);
  // Fail-closed de verdad: las formas que NO son el booleano exacto `true` no encienden nada.
  for (const valor of ['true', 1]) {
    await db.doc(`tenants/${T}/config/attachments`).set({ ingest: { enabled: valor } }, { merge: true });
    const r = await mandarArchivo(C.rolloutIngestOff, { mediaId: `MEDIA-AT-23-${valor}` });
    check(`AT-23k. \`enabled: ${JSON.stringify(valor)}\` NO enciende la ingesta (solo el booleano exacto)`,
      (await attachmentDoc(r.attachmentId)) === null,
      `doc=${(await attachmentDoc(r.attachmentId)) === null ? 'no' : 'sí'}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Limpieza (deja el emulador listo para las regresiones)
// ═══════════════════════════════════════════════════════════════════════════
await wipePrograma();
if (attachmentsCfgPrevio) await db.doc(`tenants/${T}/config/attachments`).set(attachmentsCfgPrevio);
else await db.doc(`tenants/${T}/config/attachments`).delete().catch(() => {});
await db.doc(`tenants/${T}/config/receiptGate`).delete().catch(() => {});
for (const mid of sentMids) {
  await db.doc(`metaWebhookInbox/whatsapp_${mid.replace(/[^\w.:=+-]/g, '_').slice(0, 256)}`).delete().catch(() => {});
}
await db.doc(`tenants/${T}/metaAssets/${PNID}`).delete().catch(() => {});
await db.doc(`metaExternalIndex/whatsapp_${PNID}`).delete().catch(() => {});
for (const d of assetsPreviosDocs) await db.doc(`tenants/${T}/metaAssets/${d.id}`).set(d.data);
if (channelsPrevio) await db.doc(`tenants/${T}/config/channels`).set(channelsPrevio); else await db.doc(`tenants/${T}/config/channels`).delete().catch(() => {});
if (agentPrevio) await db.doc(`tenants/${T}/config/agent`).set(agentPrevio); else await db.doc(`tenants/${T}/config/agent`).delete().catch(() => {});

const okCount = results.filter(Boolean).length;
console.log(`\nRESULTADO ADJUNTOS (ADR-0016, E2E emulador): ${okCount === results.length ? 'TODO OK ✅' : 'FALLAS ❌'} (${okCount}/${results.length})`);
process.exit(okCount === results.length ? 0 : 1);
