/**
 * verify-catalog-authority.mjs — Autoridad de catálogo autoservicio (ADR-0022) end-to-end.
 *
 * Viaje en emulador limpio:
 *  1. Tenant local-sin-Meta (sin `catalogSync`): estado derivado vendeyapy+none; el BOT responde
 *     por WhatsApp usando el catálogo local (cero dependencia de Meta); acciones Meta bloqueadas.
 *  2. Meta fake + config sembrada ⇒ clasificación legacy derivada `managed` (declared=false).
 *  3. Preview→apply a `managed` declarado: planHash, update mask estricto (enabled/mode/catalogId/
 *     ownership intactos), audit, CERO jobs de outbox, CERO opt-ins activados.
 *  4. Replay ⇒ consumed · planHash adulterado ⇒ mismatch · SELLER y cross-tenant ⇒ denegados.
 *  5. Apply a `none` declarado ⇒ import/catalogSync bloqueados con kind explícito; CRUD/bot intactos.
 *  6. Cambio concurrente de config entre preview y apply ⇒ concurrent_change sin escrituras.
 *  7. Regreso a `managed` SOLO vía nuevo preview→apply (rollback lógico, sin restauraciones ciegas).
 *  8. Objetivo inválido external+managed ⇒ bloqueo `invalid_target` sin planHash.
 *  9. Tenant 2 external+mirror (modelo arfagi): estado correcto, publicar bloqueado, opt-in
 *     bloqueado, lecturas permitidas; DOS tenants en modos distintos simultáneamente.
 * 10. Aislamiento: credipower jamás existe ni recibe escrituras; cero deletes de productos.
 *
 * Requiere: emulador (auth+firestore+functions+storage) + seed-users + load-catalog.
 */
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'demo-aiafg';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const T2 = 'boutique-demo';
const PNID = '900000000000099';
const CUST = '595993700022';
const CATALOG_ID = 'CAT-E2E-AUTH';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signIn = async (email) => { const r = await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json(); return { token: r.idToken, uid: r.localId }; };
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, msg: body.error?.message ?? '', details: body.error?.details ?? null };
}
const kindDe = (r) => r.details?.kind ?? r.details?.reason ?? '';
const waitFor = async (pred, maxMs = 15000) => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await pred()) return true; await sleep(600); } return false; };

const cfgRef = db.doc(`tenants/${T}/config/meta`);
const cfgDe = async (t) => (await db.doc(`tenants/${t}/config/meta`).get()).data()?.catalogSync ?? null;
const productosDe = async (t) => (await db.collection(`tenants/${t}/products`).count().get()).data().count;
const outboxDe = async (t) => (await db.collection(`tenants/${t}/metaCatalogOutboxJobs`).count().get()).data().count;
const audits = async (t) => (await db.collection(`tenants/${t}/auditLogs`).get()).docs.map((d) => d.data());
const status = async (token, tenantId) => (await call('metaCatalogOwnershipStatus', token, { tenantId })).result?.authority ?? null;

const OWNED_FIELDS = ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'];
const now = Timestamp.now();
const OWNERSHIP_PROPIA = { model: 'vendeyapy_managed', ownedFields: OWNED_FIELDS, external: null };
const OWN_EXTERNA = {
  model: 'external_managed', ownedFields: [],
  external: { kind: 'meta_feed', acknowledgedSourceIds: ['ds-feed-auth-e2e'], declaredFields: OWNED_FIELDS, fingerprint: 'huella-feed-auth-e2e', acknowledgedAt: now, acknowledgedByUid: 'uid-owner-e2e' },
  lastSourceCheckAt: now,
};

// ─── Setup ───
await db.doc(`tenants/${T}`).set({ planId: 'growth', subscription: { status: 'active', currentPeriodStart: now }, usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: now } }, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot AUTH' }, { merge: true });
const superadmin = await signIn('superadmin@aiafg.com');
const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const ownerB = await signIn('owner@boutique.com');
const rc = await call('adminSetManualWhatsappConnection', superadmin.token, { tenantId: T, wabaId: 'WABA-AUTH-1', phoneNumberId: PNID, displayPhoneNumber: '+595 991 000 099', accessToken: 'tok-auth-e2e-NUNCA-persistir' });
if (rc.err) { console.log('SETUP FALLÓ:', rc.err, rc.msg); process.exit(1); }
await db.doc(`tenants/${T}/metaAssets/${PNID}`).set({ automationMode: 'live' }, { merge: true });
const credipowerAntes = (await db.doc('tenants/credipower').get()).exists;
const productosAntesT1 = await productosDe(T);
const productosAntesT2 = await productosDe(T2);

// ─── 1. Local-sin-Meta: derivación + bot + bloqueo ───
const st0 = await status(owner.token, T);
check('1. Sin catalogSync ⇒ derivado vendeyapy+none (declared=false, botCatalog local_mirror)',
  st0?.authority === 'vendeyapy' && st0?.relationship === 'none' && st0?.declared === false && st0?.botCatalog === 'local_mirror', JSON.stringify(st0));

let mid = 0;
await fetch(`${BASE}/metaWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PNID }, contacts: [{ wa_id: CUST, profile: { name: 'Cliente Auth' } }], messages: [{ from: CUST, id: `wamid.AUTH-${Date.now()}-${++mid}`, timestamp: '1716750000', type: 'text', text: { body: 'Hola, ¿qué perfumes tienen?' } }] } }] }] }) });
const botRespondio = await waitFor(async () => (await db.collection(`tenants/${T}/customers/${CUST}/messages`).get()).docs.some((d) => d.data().author === 'bot'));
check('2. El BOT responde desde el catálogo local SIN ninguna config de catálogo Meta', botRespondio);

const rImp0 = await call('metaCatalogImportRun', owner.token, { tenantId: T });
check('3. Acción Meta sin config ⇒ FAILED_PRECONDITION (fail-closed, sin estado de import creado)',
  rImp0.err === 'FAILED_PRECONDITION' && !(await db.doc(`tenants/${T}/metaCatalogImportState/current`).get()).exists, `err=${rImp0.err}`);

// ─── 2. Meta fake + clasificación legacy ───
await call('devMetaConnect', superadmin.token, { tenantId: T, byUid: 'uid-owner' });
await cfgRef.set({ catalogSync: { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, sourceOfTruth: 'vendeyapy', ownership: OWNERSHIP_PROPIA } }, { merge: true });
const st1 = await status(owner.token, T);
check('4. Config legacy sembrada (sin relationship) ⇒ derivado vendeyapy+managed, declared=false',
  st1?.authority === 'vendeyapy' && st1?.relationship === 'managed' && st1?.declared === false, JSON.stringify(st1));

// ─── 3. Preview→apply a managed declarado ───
const pv1 = (await call('metaCatalogAuthorityPreview', owner.token, { tenantId: T, target: { authority: 'vendeyapy', relationship: 'managed' } })).result;
check('5. Preview a managed: ok, con planHash y advertencia already_in_target (derivado==objetivo)',
  pv1?.ok === true && !!pv1?.planHash && !!pv1?.runId && (pv1?.advertencias ?? []).includes('already_in_target') && (pv1?.bloqueos ?? []).length === 0, JSON.stringify({ adv: pv1?.advertencias, blq: pv1?.bloqueos }));

const pvSeller = await call('metaCatalogAuthorityPreview', seller.token, { tenantId: T, target: { authority: 'vendeyapy', relationship: 'managed' } });
// Convención del repo (resolveOwnerAuth): el OWNER opera SIEMPRE su propio tenant — el
// `tenantId` pedido se IGNORA. Cross-tenant es imposible por construcción, no por rechazo:
// el preview de ownerB con tenantId=T corre sobre SU tenant y jamás crea runs en T.
const runsT = (await db.collection(`tenants/${T}/metaCatalogAuthorityRuns`).count().get()).data().count;
const pvCross = await call('metaCatalogAuthorityPreview', ownerB.token, { tenantId: T, target: { authority: 'vendeyapy', relationship: 'managed' } });
const runsTDespues = (await db.collection(`tenants/${T}/metaCatalogAuthorityRuns`).count().get()).data().count;
const runsT2 = (await db.collection(`tenants/${T2}/metaCatalogAuthorityRuns`).count().get()).data().count;
check('6. SELLER denegado; owner ajeno opera SU tenant (cero runs cross-tenant en T, el suyo recibe el run)',
  pvSeller.err === 'PERMISSION_DENIED' && !pvCross.err && runsTDespues === runsT && runsT2 >= 1, `seller=${pvSeller.err} runsT=${runsT}→${runsTDespues} runsT2=${runsT2}`);

const ap1 = await call('metaCatalogAuthorityApply', owner.token, { tenantId: T, runId: pv1.runId, planHash: pv1.planHash });
const cfg1 = await cfgDe(T);
check('7. Apply escribe SOLO relationship (enabled/mode/catalogId/ownership intactos) y audita',
  !ap1.err && ap1.result?.despues?.relationship === 'managed' && cfg1?.relationship === 'managed' && cfg1?.enabled === true && cfg1?.mode === 'dry_run' && cfg1?.catalogId === CATALOG_ID && cfg1?.ownership?.model === 'vendeyapy_managed' && (await audits(T)).some((a) => a.action === 'meta.catalog_authority_changed'), `err=${ap1.err}`);
check('8. Cero jobs de outbox y cero opt-ins activados por el cambio de modo',
  (await outboxDe(T)) === 0 && (await db.collection(`tenants/${T}/products`).where('syncToMeta', '==', true).count().get()).data().count === 0);

const ap1b = await call('metaCatalogAuthorityApply', owner.token, { tenantId: T, runId: pv1.runId, planHash: pv1.planHash });
check('9. Replay del mismo run ⇒ consumed', ap1b.err === 'FAILED_PRECONDITION' && kindDe(ap1b) === 'consumed', `kind=${kindDe(ap1b)}`);

// ─── 4. A none declarado: mismatch primero, apply después, gates explícitos ───
const pv2 = (await call('metaCatalogAuthorityPreview', owner.token, { tenantId: T, target: { authority: 'vendeyapy', relationship: 'none' } })).result;
const apMal = await call('metaCatalogAuthorityApply', owner.token, { tenantId: T, runId: pv2.runId, planHash: 'a'.repeat(32) });
check('10. planHash adulterado ⇒ mismatch sin consumir el run', apMal.err === 'FAILED_PRECONDITION' && kindDe(apMal) === 'mismatch', `kind=${kindDe(apMal)}`);
const ap2 = await call('metaCatalogAuthorityApply', owner.token, { tenantId: T, runId: pv2.runId, planHash: pv2.planHash });
const cfg2 = await cfgDe(T);
check('11. Apply a none declarado (el resto de la config intacta)', !ap2.err && cfg2?.relationship === 'none' && cfg2?.enabled === true && cfg2?.catalogId === CATALOG_ID, `err=${ap2.err}`);

const rImp1 = await call('metaCatalogImportRun', owner.token, { tenantId: T });
const rJob1 = await call('runTenantJob', owner.token, { tenantId: T, action: 'catalogSync' });
check('12. En none declarado: import y catalogSync bloqueados con authority_relationship_blocked',
  rImp1.err === 'FAILED_PRECONDITION' && kindDe(rImp1) === 'authority_relationship_blocked' && rJob1.err === 'FAILED_PRECONDITION' && kindDe(rJob1) === 'authority_relationship_blocked', `imp=${kindDe(rImp1)} job=${kindDe(rJob1)}`);

// ─── 5. Cambio concurrente ───
const pv3 = (await call('metaCatalogAuthorityPreview', owner.token, { tenantId: T, target: { authority: 'vendeyapy', relationship: 'managed' } })).result;
await cfgRef.update({ 'catalogSync.enabled': false });
const ap3 = await call('metaCatalogAuthorityApply', owner.token, { tenantId: T, runId: pv3.runId, planHash: pv3.planHash });
check('13. Config mutada entre preview y apply ⇒ concurrent_change y relationship NO cambia',
  ap3.err === 'FAILED_PRECONDITION' && kindDe(ap3) === 'concurrent_change' && (await cfgDe(T))?.relationship === 'none', `kind=${kindDe(ap3)}`);
await cfgRef.update({ 'catalogSync.enabled': true });

// ─── 6. Regreso a managed SOLO por nuevo preview→apply ───
const pv4 = (await call('metaCatalogAuthorityPreview', owner.token, { tenantId: T, target: { authority: 'vendeyapy', relationship: 'managed' } })).result;
const ap4 = await call('metaCatalogAuthorityApply', owner.token, { tenantId: T, runId: pv4.runId, planHash: pv4.planHash });
const rImp2 = await call('metaCatalogImportRun', owner.token, { tenantId: T });
check('14. Regreso a managed: apply ok y el gate de import se abre (ya no authority_relationship_blocked)',
  !ap4.err && (await cfgDe(T))?.relationship === 'managed' && kindDe(rImp2) !== 'authority_relationship_blocked', `imp=${rImp2.err ?? 'ok'}:${kindDe(rImp2)}`);

// ─── 7. Objetivo inválido ───
const pvInv = (await call('metaCatalogAuthorityPreview', owner.token, { tenantId: T, target: { authority: 'external', relationship: 'managed' } })).result;
check('15. external+managed ⇒ bloqueo invalid_target y SIN planHash', (pvInv?.bloqueos ?? []).some((b) => b.id === 'invalid_target') && !pvInv?.planHash, JSON.stringify(pvInv?.bloqueos));

// ─── 8. Tenant 2: external+mirror (modelo arfagi) ───
await db.doc(`tenants/${T2}`).set({ planId: 'growth', subscription: { status: 'active', currentPeriodStart: now }, usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, currentPeriodStart: now } }, { merge: true });
await db.doc(`tenants/${T2}/config/meta`).set({ catalogSync: { enabled: true, mode: 'dry_run', catalogId: 'CAT-E2E-EXT', sourceOfTruth: 'vendeyapy', ownership: OWN_EXTERNA } }, { merge: true });
await db.doc(`tenants/${T2}/products/p-ext-1`).set({ id: 'p-ext-1', tenantId: T2, name: 'Producto Feed', price: 100000, currency: 'PYG', status: 'ACTIVE', inventory: { trackStock: false, stock: 0 }, createdAt: now, updatedAt: now });
const stB = await status(ownerB.token, T2);
check('16. T2 (external_managed + meta_feed) ⇒ derivado external+mirror con staleness real',
  stB?.authority === 'external' && stB?.relationship === 'mirror' && stB?.declared === false && stB?.staleness?.lastSourceCheckAt != null, JSON.stringify(stB));

const rApplyB = await call('runTenantJob', ownerB.token, { tenantId: T2, action: 'catalogSyncApply', args: { previewRunId: 'mcs_x', planHash: 'f'.repeat(32) } });
const rOpt = await call('metaCatalogSetSyncEnabled', ownerB.token, { tenantId: T2, productId: 'p-ext-1', enabled: true });
// El opt-in bajo mirror lo corta PRIMERO el gate de propiedad (writable=0, respuesta amable con
// el motivo y a dónde corregir — orden deliberado ADR-0022 §4); el gate de relación queda detrás
// como defensa en profundidad (inalcanzable bajo mirror: external_managed ⟺ writable vacío).
// Aserción fuerte: bloqueado con ownershipBlocked=true y jamás habilitado.
const optBloqueado = rOpt.result?.ok === false && rOpt.result?.ownershipBlocked === true;
check('17. Mirror: publicar (catalogSyncApply) bloqueado por relación; opt-in bloqueado por propiedad',
  rApplyB.err === 'FAILED_PRECONDITION' && kindDe(rApplyB) === 'authority_relationship_blocked' && optBloqueado, `apply=${kindDe(rApplyB)} opt=${JSON.stringify({ ok: rOpt.result?.ok, ownershipBlocked: rOpt.result?.ownershipBlocked })}`);
const rPlanB = await call('metaCatalogReconcilePlan', ownerB.token, { tenantId: T2, offset: 0, limit: 5 });
// Decisión B2 de la review: mirror bloquea ESCRITURAS, no lecturas — el dry-run `catalogSync`
// (diagnóstico read-only, comportamiento legacy de arfagi) debe pasar el gate de relación.
const rDryB = await call('runTenantJob', ownerB.token, { tenantId: T2, action: 'catalogSync' });
check('18. Mirror: reconciliar y el dry-run catalogSync NO están bloqueados por autoridad (lecturas permitidas)',
  kindDe(rPlanB) !== 'authority_relationship_blocked' && kindDe(rDryB) !== 'authority_relationship_blocked', `plan=${rPlanB.err ?? 'ok'}:${kindDe(rPlanB)} dry=${rDryB.err ?? 'ok'}:${kindDe(rDryB)}`);

// ─── 9. Dos tenants en modos distintos, simultáneamente ───
const [stT1, stT2] = await Promise.all([status(owner.token, T), status(ownerB.token, T2)]);
check('19. Simultáneo: T1 vendeyapy+managed (declarado) y T2 external+mirror', stT1?.relationship === 'managed' && stT1?.declared === true && stT2?.relationship === 'mirror' && stT2?.authority === 'external');

// ─── 10. Aislamiento y cero destrucción ───
const todosLosRuns = (await db.collection(`tenants/${T}/metaCatalogAuthorityRuns`).get()).docs
  .concat((await db.collection(`tenants/${T2}/metaCatalogAuthorityRuns`).get()).docs);
const runsSucios = todosLosRuns.filter((d) => /token|https?:\/\/|secret:/i.test(JSON.stringify(d.data())));
check(`20. NINGÚN run de autoridad (${todosLosRuns.length} en ambos tenants) contiene tokens, URLs ni secretos`,
  todosLosRuns.length > 0 && runsSucios.length === 0, `sucios=${runsSucios.map((d) => d.id).join(',')}`);
check('21. Cero deletes: conteo de productos idéntico en ambos tenants (+1 sembrado en T2)',
  (await productosDe(T)) === productosAntesT1 && (await productosDe(T2)) === productosAntesT2 + 1, `T1 ${productosAntesT1}→${await productosDe(T)} T2 ${productosAntesT2}→${await productosDe(T2)}`);
check('22. credipower jamás existió ni recibió escrituras', credipowerAntes === false && (await db.doc('tenants/credipower').get()).exists === false && (await db.collection('tenants/credipower/metaCatalogAuthorityRuns').count().get()).data().count === 0);
check('23. Outbox final en cero para ambos tenants (ningún job Meta creado por el programa)', (await outboxDe(T)) === 0 && (await outboxDe(T2)) === 0);

const ok = results.every((r) => r);
console.log(`\nRESULTADO CATALOG-AUTHORITY: ${ok ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${results.filter((r) => r).length}/${results.length})`);
process.exit(ok ? 0 : 1);
