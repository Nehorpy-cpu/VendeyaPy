/**
 * verify-conversations-inbox.mjs — Bandeja de conversaciones profesional (ADR-0021) end-to-end.
 *
 * Recorrido completo en emulador limpio:
 *  1. Conexión mock + entrante por webhook → perfil (`profileName`) capturado sin pisar `name`.
 *  2. Fixtures multi-día → contrato de paginación (desc + cursor, sin duplicados).
 *  3. Takeover → no-leídos → conversationMarkRead (idempotente).
 *  4. Texto manual + adjuntos salientes (imagen y PDF): validación, idempotencia por operationId,
 *     caption en el DOC de adjunto (jamás en el texto del mensaje), archivo real en Storage.
 *  5. Hostiles: MIME falso (PNG declarado, bytes MZ), SVG, oversize → rechazo sin efectos.
 *  6. El adjunto SALIENTE no puede marcarse comprobante (attachment_outbound).
 *  7. Recibos del proveedor por el camino REAL (webhook → inbox → process): sent→delivered→read
 *     monotónico; tardíos/failed/desconocidos no regresan el estado.
 *  8. Vínculo a cliente: crear (crm_*), vincular/desvincular, destino inexistente rechazado.
 *  9. customerSearch por nombre y por teléfono; query vacía rechazada.
 * 10. Asignación: owner asigna/desasigna; uid fantasma y SELLER rechazados.
 * 11. Archivar (seller) → entrante desarchiva; archivada + envío manual desarchiva.
 * 12. Eliminación LÓGICA (solo manager+): bloquea envíos; mensajes/adjuntos/audits/Storage
 *     INTACTOS; restaurar rehabilita.
 * 13. Cross-tenant denegado; release → el bot vuelve a atender (regresión).
 *
 * NOTA (fixture honesto): en emulador todo saliente es viaMock (sin wamid de Meta), así que para
 * el paso 7 se siembra UNA burbuja saliente con waMessageId + deliveryStatus 'pending' tal como
 * la dejaría un envío live; los recibos viajan por el webhook real.
 *
 * Requiere: emulador (auth+firestore+functions+storage) + seed-users + load-catalog.
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
const T2 = 'boutique';
const PNID = '900000000000088';
const CUST = '595993600011';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => { const r = await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json(); return { token: r.idToken, uid: r.localId }; };
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? '' };
}
let mid = 0;
const postValue = (value) => fetch(`${BASE}/metaWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, ...value } }] }] }),
});
const postText = (from, body, profileName) => postValue({
  contacts: [{ wa_id: from, profile: { name: profileName } }],
  messages: [{ from, id: `wamid.CONV-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body } }],
});
const postStatus = (wamid, status, ts, extra = {}) => postValue({ statuses: [{ id: wamid, status, timestamp: String(ts), recipient_id: CUST, ...extra }] });

const custRef = db.doc(`tenants/${T}/customers/${CUST}`);
const custData = async () => (await custRef.get()).data() ?? {};
const msgs = async () => (await custRef.collection('messages').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const attCount = async () => (await db.collection(`tenants/${T}/attachments`).count().get()).data().count;
const auditCount = async () => (await db.collection(`tenants/${T}/auditLogs`).count().get()).data().count;
const audits = async () => (await db.collection(`tenants/${T}/auditLogs`).get()).docs.map((d) => d.data());
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };

// Fixtures binarios (magic bytes reales)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');
const EXE_B64 = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 7)]).toString('base64');
const SVG_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
const BIG_B64 = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64');

// ─── Setup ───
await db.doc(`tenants/${T}`).set({ planId: 'starter', subscription: { status: 'active', currentPeriodStart: Timestamp.now() }, usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: Timestamp.now() } }, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot CONV' }, { merge: true });
await db.doc(`tenants/${T}/config/checkout`).set({ sellers: [{ name: 'Aaron Test', whatsapp: '595991000000' }] }, { merge: true });
const adminU = await signIn('superadmin@aiafg.com');
const rc = await call('adminSetManualWhatsappConnection', adminU.token, { tenantId: T, wabaId: 'WABA-CONV-1', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 088', accessToken: 'tok-conv-e2e-NUNCA-persistir' });
if (rc.err) { console.log('SETUP FALLÓ:', rc.err, rc.msg); process.exit(1); }
// ADR-0017 §1: el alta deja `automationMode` AUSENTE a propósito (fail-closed). Para el E2E el
// número declara 'live' igual que verify-human-handoff, si no el motor no automatiza el inbound.
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ automationMode: 'live' }, { merge: true });
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');

// ─── 1. Entrante + perfil ───
await postText(CUST, 'Hola, quiero el perfume Odyssey', 'Rocío García');
await waitFor(async () => (await msgs()).some((m) => m.direction === 'out' && m.author === 'bot'));
let c = await custData();
check('1. profileName capturado del webhook sin pisar name CRM', c.profileName === 'Rocío García' && !c.name, `profileName=${c.profileName} name=${JSON.stringify(c.name ?? null)}`);
check('2. Burbuja del bot viaMock SIN deliveryStatus (nada salió a un proveedor)', (await msgs()).some((m) => m.author === 'bot' && m.viaMock === true && m.deliveryStatus === undefined));

// ─── 2. Fixtures multi-día + contrato de paginación ───
const daysAgo = (d) => Timestamp.fromMillis(Date.now() - d * 24 * 3600 * 1000);
await custRef.collection('messages').doc('e2e-old-1').set({ id: 'e2e-old-1', tenantId: T, customerId: CUST, direction: 'in', author: 'customer', text: 'Mensaje de hace dos días', createdAt: daysAgo(2) });
await custRef.collection('messages').doc('e2e-old-2').set({ id: 'e2e-old-2', tenantId: T, customerId: CUST, direction: 'out', author: 'bot', text: 'Respuesta de ayer', createdAt: daysAgo(1), viaMock: true });
const w1 = await custRef.collection('messages').orderBy('createdAt', 'desc').limit(2).get();
const w2 = await custRef.collection('messages').orderBy('createdAt', 'desc').startAfter(w1.docs[w1.docs.length - 1]).limit(2).get();
const ids1 = w1.docs.map((d) => d.id); const ids2 = w2.docs.map((d) => d.id);
check('3. Paginación desc + cursor sin duplicados y con orden no-creciente', ids2.length > 0 && !ids2.some((i) => ids1.includes(i)) && w1.docs[1].data().createdAt.toMillis() >= w2.docs[0].data().createdAt.toMillis(), `w1=${ids1} w2=${ids2}`);

// ─── 3. Takeover + no-leídos + markRead ───
const rt = await call('chatTakeover', seller.token, { tenantId: T, customerId: CUST });
c = await custData();
check('4. Takeover: humano activo, asignado al seller, no-leídos en cero', !rt.err && c.conversation?.humanTakeover === true && c.assignedSellerId === seller.uid && c.conversation?.unreadForSeller === 0);
const botCountBefore = (await msgs()).filter((m) => m.author === 'bot').length;
await postText(CUST, '¿Cuánto sale?', 'Rocío García');
await waitFor(async () => (await custData()).conversation?.unreadForSeller === 1);
c = await custData();
await sleep(2500);
check('5. Entrante en takeover: no-leídos=1 y el bot NO responde', c.conversation?.unreadForSeller === 1 && (await msgs()).filter((m) => m.author === 'bot').length === botCountBefore, `unread=${c.conversation?.unreadForSeller}`);
const rmr = await call('conversationMarkRead', seller.token, { tenantId: T, customerId: CUST });
const rmr2 = await call('conversationMarkRead', seller.token, { tenantId: T, customerId: CUST });
c = await custData();
check('6. conversationMarkRead resetea y es idempotente', !rmr.err && !rmr2.err && c.conversation?.unreadForSeller === 0);

// ─── 4. Texto manual + adjuntos salientes ───
const rtx = await call('conversationSendManualMessage', seller.token, { tenantId: T, customerId: CUST, text: 'Con gusto, ya te paso el catálogo' });
check('7. Texto manual del seller persistido viaMock', !rtx.err && (await msgs()).some((m) => m.author === 'seller' && m.viaMock === true && m.text.includes('catálogo')));

const OP1 = 'e2e-op-imagen-1';
const ra1 = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: OP1, kind: 'image', filename: 'catalogo odyssey.png', mimeType: 'image/png', dataBase64: PNG_B64, caption: 'Catálogo Odyssey ✨' });
const att1 = ra1.result?.attachmentId ?? null;
const attDoc1 = att1 ? (await db.doc(`tenants/${T}/attachments/${att1}`).get()).data() : null;
const msgAtt1 = (await msgs()).find((m) => (m.attachmentIds ?? []).includes(att1));
check('8. Imagen saliente: doc out/panel, caption en el ADJUNTO y texto de mensaje vacío', !!attDoc1 && attDoc1.direction === 'out' && attDoc1.origin === 'panel' && attDoc1.caption?.includes('Odyssey') && !!msgAtt1 && msgAtt1.text === '' && msgAtt1.author === 'seller', `err=${ra1.err ?? ''}`);
check('9. Storage: el archivo saliente existe en la ruta opaca', !!attDoc1?.storage?.path && (await bucket.file(attDoc1.storage.path).exists())[0]);
const attsBeforeDup = await attCount();
const ra1b = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: OP1, kind: 'image', filename: 'catalogo odyssey.png', mimeType: 'image/png', dataBase64: PNG_B64, caption: 'Catálogo Odyssey ✨' });
check('10. Idempotencia por operationId: replay devuelve el previo, sin duplicar nada', !ra1b.err && ra1b.result?.duplicate === true && ra1b.result?.attachmentId === att1 && (await attCount()) === attsBeforeDup && (await msgs()).filter((m) => (m.attachmentIds ?? []).includes(att1)).length === 1);
const ra2 = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: 'e2e-op-pdf-1', kind: 'document', filename: 'lista-precios.pdf', mimeType: 'application/pdf', dataBase64: PDF_B64 });
check('11. PDF saliente aceptado (documento)', !ra2.err && !!ra2.result?.attachmentId);

// ─── 5. Hostiles: sin efectos ───
const attsBefore = await attCount(); const msgsBefore = (await msgs()).length;
const rh1 = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: 'e2e-op-mz', kind: 'image', filename: 'foto.png', mimeType: 'image/png', dataBase64: EXE_B64 });
check('12. MIME falso (PNG declarado, bytes MZ) rechazado sin efectos', !!rh1.err && (await attCount()) === attsBefore && (await msgs()).length === msgsBefore);
const rh2 = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: 'e2e-op-svg', kind: 'image', filename: 'img.svg', mimeType: 'image/svg+xml', dataBase64: SVG_B64 });
check('13. SVG rechazado (allowlist)', !!rh2.err && (await attCount()) === attsBefore);
const rh3 = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: 'e2e-op-big', kind: 'image', filename: 'grande.png', mimeType: 'image/png', dataBase64: BIG_B64 });
check('14. Oversize (5MB+1) rechazado', !!rh3.err && (await attCount()) === attsBefore);

// ─── 6. El saliente jamás es comprobante ───
// El cerrojo exacto (direction 'out' ⇒ attachment_outbound en decideMarkAsReceipt) está fijado por
// los tests unitarios receiptGate.outbound. Acá se verifica el PRIMER cerrojo end-to-end: el
// adjunto saliente nace 'generic_media' por regla (el gate automático y linkReceiptCandidate solo
// consideran 'unclassified'), y el intento de marcarlo falla.
const rmk = await call('attachmentMarkAsReceipt', owner.token, { tenantId: T, attachmentId: att1, orderId: 'ord-e2e-inexistente' });
check('15. Saliente fuera del circuito de comprobantes (generic_media por regla + marcado rechazado)', attDoc1?.classification?.value === 'generic_media' && attDoc1?.classification?.source === 'rule' && !!rmk.err, `class=${attDoc1?.classification?.value} err=${rmk.err}`);

// ─── 7. Recibos del proveedor por el camino real ───
const WDS = 'wamid.E2EDS1';
await custRef.collection('messages').doc('e2e-delivery-1').set({ id: 'e2e-delivery-1', tenantId: T, customerId: CUST, direction: 'out', author: 'seller', text: 'fixture de entrega live', createdAt: Timestamp.now(), waMessageId: WDS, deliveryStatus: 'pending' });
const dsOf = async () => (await custRef.collection('messages').doc('e2e-delivery-1').get()).data();
await postStatus(WDS, 'sent', 1716750100);
check('16. Recibo sent aplicado con timestamp del proveedor', await waitFor(async () => (await dsOf()).deliveryStatus === 'sent') && !!(await dsOf()).deliveryAt?.sent);
await postStatus(WDS, 'delivered', 1716750200);
check('17. Recibo delivered aplicado', await waitFor(async () => (await dsOf()).deliveryStatus === 'delivered'));
await postStatus(WDS, 'read', 1716750300);
check('18. Recibo read aplicado', await waitFor(async () => (await dsOf()).deliveryStatus === 'read'));
await postStatus(WDS, 'delivered', 1716750400); await sleep(2500);
check('19. Recibo tardío (delivered después de read) NO regresa el estado', (await dsOf()).deliveryStatus === 'read');
await postStatus(WDS, 'failed', 1716750500, { errors: [{ code: 131026, title: 'Undeliverable' }] }); await sleep(2500);
const dsFinal = await dsOf();
check('20. failed después de read ignorado (terminal honesto)', dsFinal.deliveryStatus === 'read' && !dsFinal.deliveryError);
await postStatus(WDS, 'warned', 1716750600); await sleep(1500);
check('21. Estado desconocido del proveedor ignorado sin romper nada', (await dsOf()).deliveryStatus === 'read');

// ─── 8. Vínculo a cliente ───
const rcc = await call('conversationCreateClient', owner.token, { tenantId: T, customerId: CUST, name: 'Rocío García SRL', notes: 'Mayorista' });
const clientId = rcc.result?.clientId ?? '';
c = await custData();
check('22. conversationCreateClient crea crm_* y vincula', !rcc.err && clientId.startsWith('crm_') && c.linkedClientId === clientId && (await db.doc(`tenants/${T}/customers/${clientId}`).get()).data()?.name === 'Rocío García SRL');
const rlkBad = await call('conversationLinkClient', owner.token, { tenantId: T, customerId: CUST, clientId: 'crm_inexistente' });
check('23. Vincular a destino inexistente rechazado', !!rlkBad.err);
const runl = await call('conversationUnlinkClient', owner.token, { tenantId: T, customerId: CUST });
c = await custData();
check('24. Desvincular limpia el vínculo', !runl.err && !c.linkedClientId);
await call('conversationLinkClient', owner.token, { tenantId: T, customerId: CUST, clientId });
const auditActions = (await audits()).map((a) => a.action);
check('25. Audits de vínculo presentes', auditActions.includes('conversation.client_created') && auditActions.includes('conversation.client_linked'));

// ─── 9. Búsqueda ───
const rs1 = await call('customerSearch', seller.token, { tenantId: T, query: 'Roc' });
const rs2 = await call('customerSearch', seller.token, { tenantId: T, query: '5959936' });
const rs3 = await call('customerSearch', seller.token, { tenantId: T, query: '   ' });
check('26. customerSearch por prefijo de nombre encuentra la ficha CRM', !rs1.err && (rs1.result?.items ?? []).some((i) => i.id === clientId));
check('27. customerSearch por teléfono encuentra la conversación', !rs2.err && (rs2.result?.items ?? []).some((i) => i.id === CUST));
check('28. customerSearch con query vacía → INVALID_ARGUMENT', rs3.err === 'INVALID_ARGUMENT');

// ─── 10. Asignación ───
const ras = await call('conversationAssign', owner.token, { tenantId: T, customerId: CUST, sellerUid: seller.uid });
c = await custData();
check('29. Owner asigna vendedor validado del tenant', !ras.err && c.assignedSellerId === seller.uid && !!c.assignedSellerName);
const rasBad = await call('conversationAssign', owner.token, { tenantId: T, customerId: CUST, sellerUid: 'uid-fantasma-999' });
check('30. Asignar a uid ajeno al tenant rechazado', !!rasBad.err);
const rasSeller = await call('conversationAssign', seller.token, { tenantId: T, customerId: CUST, sellerUid: null });
check('31. SELLER no puede asignar (matriz §7)', rasSeller.err === 'PERMISSION_DENIED');
const rasNull = await call('conversationAssign', owner.token, { tenantId: T, customerId: CUST, sellerUid: null });
c = await custData();
check('32. Desasignar (null) limpia', !rasNull.err && !c.assignedSellerId);

// ─── 11. Archivar / desarchivar ───
const rar = await call('conversationArchive', seller.token, { tenantId: T, customerId: CUST });
c = await custData();
check('33. SELLER archiva (reversible, auditado)', !rar.err && c.conversation?.archived === true && (await audits()).some((a) => a.action === 'conversation.archived'));
await postText(CUST, 'Sigo acá, ¿me pasás el precio?', 'Rocío García');
check('34. Un entrante nuevo DESARCHIVA automáticamente', await waitFor(async () => (await custData()).conversation?.archived !== true));
await call('conversationArchive', seller.token, { tenantId: T, customerId: CUST });
const rtx2 = await call('conversationSendManualMessage', seller.token, { tenantId: T, customerId: CUST, text: 'Te escribo yo: sale 190.000' });
c = await custData();
check('35. Enviar manual a archivada: envía Y desarchiva', !rtx2.err && c.conversation?.archived !== true);

// ─── 12. Eliminación lógica ───
const rdsSeller = await call('conversationSoftDelete', seller.token, { tenantId: T, customerId: CUST });
check('36. SELLER no puede eliminar lógicamente (matriz §7)', rdsSeller.err === 'PERMISSION_DENIED');
const beforeDel = { m: (await msgs()).length, a: await attCount(), au: await auditCount() };
const rdel = await call('conversationSoftDelete', owner.token, { tenantId: T, customerId: CUST });
c = await custData();
check('37. Owner elimina lógicamente (softDeleted=true, archived intacto)', !rdel.err && c.conversation?.softDeleted === true);
const rtxDel = await call('conversationSendManualMessage', seller.token, { tenantId: T, customerId: CUST, text: 'no debería salir' });
const raDel = await call('conversationSendAttachment', seller.token, { tenantId: T, customerId: CUST, operationId: 'e2e-op-del', kind: 'image', filename: 'x.png', mimeType: 'image/png', dataBase64: PNG_B64 });
check('38. Conversación eliminada bloquea texto Y adjunto (fail-closed)', rtxDel.err === 'FAILED_PRECONDITION' && raDel.err === 'FAILED_PRECONDITION', `txt=${rtxDel.err} att=${raDel.err}`);
const afterDel = { m: (await msgs()).length, a: await attCount(), au: await auditCount() };
check('39. NADA se borró físicamente (mensajes/adjuntos/audits idénticos + Storage vivo)', afterDel.m === beforeDel.m && afterDel.a === beforeDel.a && afterDel.au >= beforeDel.au && (await bucket.file(attDoc1.storage.path).exists())[0], JSON.stringify({ beforeDel, afterDel }));
const rres = await call('conversationRestore', owner.token, { tenantId: T, customerId: CUST });
const rtxRes = await call('conversationSendManualMessage', seller.token, { tenantId: T, customerId: CUST, text: 'Volvimos: ¿te reservo uno?' });
check('40. Restaurar rehabilita el envío', !rres.err && !rtxRes.err && (await custData()).conversation?.softDeleted !== true);

// ─── 13. Cross-tenant + regreso del bot ───
const rxt = await call('conversationArchive', seller.token, { tenantId: T2, customerId: CUST });
check('41. Cross-tenant denegado (seller de perfumeria sobre boutique)', rxt.err === 'PERMISSION_DENIED');
const rrel = await call('chatRelease', seller.token, { tenantId: T, customerId: CUST });
const botMsgsBefore = (await msgs()).filter((m) => m.author === 'bot').length;
await postText(CUST, 'Hola de nuevo, ¿tienen stock?', 'Rocío García');
check('42. Tras release el bot vuelve a atender (regresión de handoff)', !rrel.err && await waitFor(async () => (await msgs()).filter((m) => m.author === 'bot').length > botMsgsBefore), `botAntes=${botMsgsBefore}`);

const ok = results.every((r) => r);
console.log(`\nRESULTADO CONVERSACIONES: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
