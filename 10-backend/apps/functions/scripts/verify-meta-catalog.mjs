/**
 * verify-meta-catalog.mjs — META-CATALOG-LIVE-1 end-to-end (emulador limpio).
 * Sync real de catálogo VendeyaPy→Meta con cliente FAKE por fixtures (JAMÁS Meta real):
 * autorización por rol (SELLER denegado, cross-tenant aislado), config fail-closed,
 * dry-run con plan completo y CERO escrituras, apply gateado por mode live, upserts
 * idempotentes sin delete, payloads sin datos internos, fallas de API y entitlements.
 *
 * Requiere: emulador (auth+functions+firestore) + seed-users. (load-catalog opcional:
 * los asserts usan SOLO productos MCE2E-*.)
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const T2 = 'boutique-demo'; // tenant SIN config de sync (análogo a credipower: fail-closed)
const CATALOG_ID = 'CAT-E2E-1';
const FIXTURE = 'metaTestFixtures/catalog';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null };
}
/**
 * Corre el mantenimiento del outbox (sweep + drenaje + confirmación) de UN tenant.
 * `graceMs=0` saltea la ventana de gracia de la confirmación diferida (que en producción
 * existe porque `items_batch` es asíncrono); la ventana se prueba aparte con `graceMs` real.
 */
async function drain(tenantId = T, graceMs = 0) {
  const res = await fetch(`${BASE}/devRunMetaCatalogOutbox?tenantId=${encodeURIComponent(tenantId)}&graceMs=${graceMs}`, { headers: { 'x-dev-key': 'dev-local' } });
  return (await res.json().catch(() => ({}))).result ?? null;
}

const now = Timestamp.now();
const TS = { createdAt: now, updatedAt: now };
const INV = (sku, stock = 5) => ({ trackStock: true, stock, lowStockThreshold: 1, sku });
const IMG = 'https://cdn.e2e.test/mce2e.jpg';
// syncToMeta:true por defecto = producto GESTIONADO. El gate fail-closed
// (META-CATALOG-RECONCILIATION-1) excluye del plan a todo lo que no lo tenga.
const prodDoc = (id, over = {}) => ({
  id, tenantId: T, name: `Producto ${id}`, description: `Descripción pública de ${id}`,
  price: 250000, compareAtPrice: null, aiNotes: `SECRETO-INTERNO-${id}`, currency: 'PYG',
  categoryId: 'perfumes', images: [IMG], emoji: '🌸', inventory: INV(id),
  status: 'ACTIVE', featured: false, position: 90, externalIds: { facebook: null, instagram: null, tiktok: null },
  // marca + productUrl: obligatorias del contrato de CREACIÓN de Meta
  // (META-CATALOG-OUTBOUND-CONTRACT-1). Sin ellas, todo `create` queda bloqueado.
  perfume: { brand: 'MarcaE2E' }, productUrl: `https://tienda.e2e.test/p/${id}`,
  aiFicha: { cuandoRecomendar: `FICHA-INTERNA-${id}` }, syncToMeta: true, ...TS, ...over,
});
const remoteItem = (retailerId, over = {}) => ({
  id: `itm-${retailerId}`, retailer_id: retailerId, name: `Producto ${retailerId}`,
  description: `Descripción pública de ${retailerId}`, availability: 'in stock',
  // `url` espeja productUrl del producto local: la URL entra al diff y a la verificación.
  // `condition` entra en la lectura: un CREATE lo manda, así que sin él la confirmación
  // quedaría sin evidencia para ese campo (y el artículo nunca podría declararse sincronizado).
  price: '₲250.000', image_url: IMG, brand: 'MarcaE2E', url: `https://tienda.e2e.test/p/${retailerId}`, condition: 'new', ...over,
});

const writesSnap = () => db.collection(`${FIXTURE}/writes`).get();
const productOf = async (id) => (await db.doc(`tenants/${T}/products/${id}`).get()).data() ?? null;
const runDocOf = async (tenant, runId) => (await db.doc(`tenants/${tenant}/metaCatalogSyncRuns/${runId}`).get()).data() ?? null;
const auditsOf = async (tenant) => (await db.collection(`tenants/${tenant}/auditLogs`).where('action', '==', 'meta.catalog_sync').get()).docs.map((d) => d.data());
const entryOf = (run, productId) => (run?.entries ?? []).find((e) => e.productId === productId) ?? null;
const setConfig = (catalogSync) => db.doc(`tenants/${T}/config/meta`).set({ catalogSync }, { merge: true });
const VALID_CFG = { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, sourceOfTruth: 'vendeyapy' };

// ═══ Setup ═══
console.log('\n═══ META-CATALOG-LIVE-1 · E2E con cliente fake (cero Meta real) ═══\n');
// Limpieza idempotente (permite re-correr sin reiniciar el emulador).
const wipe = async (col) => { const s = await db.collection(col).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); };
await wipe(`${FIXTURE}/writes`);
await wipe(`tenants/${T}/metaCatalogSyncRuns`);
await wipe(`tenants/${T}/metaCatalogSyncLogs`);
await wipe(`tenants/${T}/auditLogs`);
await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});
// Productos creados/mapeados por una corrida anterior de este script (si quedan, sus
// vínculos reclamarían artículos remotos y falsearían los conteos de remoteOnly).
await db.doc(`tenants/${T}/products/MCE2E-IMP`).delete().catch(() => {});
await db.doc(`tenants/${T}/products/MCE2E-SKUCHOQUE`).delete().catch(() => {});
await db.doc(`tenants/${T}/products/MCE2E-NOSYNC`).delete().catch(() => {});
await wipe(`tenants/${T}/metaRetailerLocks`);
for (const d of (await db.collection(`tenants/${T}/products`).where('metaRetailerId', '!=', null).get()).docs) {
  if (d.id.startsWith('MCE2E-') && !['MCE2E-A', 'MCE2E-B', 'MCE2E-C', 'MCE2E-D1', 'MCE2E-D2', 'MCE2E-E', 'MCE2E-F', 'MCE2E-G', 'MCE2E-ARC'].includes(d.id)) await d.ref.delete();
  else if (!d.id.startsWith('MCE2E-')) await d.ref.delete(); // importados con id autogenerado
}
await db.doc(`tenants/${T}`).set({
  name: 'Perfumería E2E', slug: T, status: 'ACTIVE', planId: 'growth',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
  updatedAt: now,
}, { merge: true });
await db.doc(`tenants/${T2}`).set({ name: 'Boutique E2E', slug: T2, status: 'ACTIVE', planId: 'growth', subscription: { status: 'active', currentPeriodStart: now }, updatedAt: now }, { merge: true });

// Productos controlados MCE2E-* (los del seed load-catalog, si existen, no participan de los asserts).
await db.doc(`tenants/${T}/products/MCE2E-A`).set(prodDoc('MCE2E-A'));                                        // create
await db.doc(`tenants/${T}/products/MCE2E-B`).set(prodDoc('MCE2E-B'));                                       // unchanged (remoto idéntico)
await db.doc(`tenants/${T}/products/MCE2E-C`).set(prodDoc('MCE2E-C', { inventory: INV('MCE2E-C', 0) }));      // disable (sin stock, remoto visible)
await db.doc(`tenants/${T}/products/MCE2E-D1`).set(prodDoc('MCE2E-D1', { inventory: INV('MCE2E-DUP') }));     // blocked sku_duplicated
await db.doc(`tenants/${T}/products/MCE2E-D2`).set(prodDoc('MCE2E-D2', { inventory: INV('MCE2E-DUP') }));     // blocked sku_duplicated
await db.doc(`tenants/${T}/products/MCE2E-E`).set(prodDoc('MCE2E-E', { inventory: INV('') }));                // blocked sku_missing
await db.doc(`tenants/${T}/products/MCE2E-F`).set(prodDoc('MCE2E-F', { images: ['http://inseguro/x.jpg'] })); // blocked image_not_https
await db.doc(`tenants/${T}/products/MCE2E-G`).set(prodDoc('MCE2E-G', { name: 'Item Huérfano Meta' }));        // blocked name_conflict (sugerencia)
await db.doc(`tenants/${T}/products/MCE2E-ARC`).set(prodDoc('MCE2E-ARC', { status: 'ARCHIVED' }));            // disable (archivado, remoto visible)
await db.doc(`tenants/${T2}/products/MCE2E-X`).set({ ...prodDoc('MCE2E-X'), tenantId: T2 });                  // tenant aislado

// Fixture del catálogo fake en Meta.
const FIXTURE_ITEMS = [
  remoteItem('MCE2E-B'),
  remoteItem('MCE2E-C'),
  remoteItem('MCE2E-ARC'),
  remoteItem('MCE2E-HUERFANO', { name: 'Item Huérfano Meta' }), // conflicto de nombre con MCE2E-G + remoteOnly
  remoteItem('MCE2E-ORPHAN2', { name: 'Solo en Meta' }),        // remoteOnly puro
];
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS });

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');
const ownerBoutique = await signIn('owner@boutique.com');

// ═══ A. Autorización ═══
{
  const { err } = await call('runTenantJob', seller, { action: 'catalogSync', tenantId: T });
  check('1. SELLER denegado en catalogSync (resolvePanelAuth)', err === 'PERMISSION_DENIED', `err=${err}`);
}
{
  const { err } = await call('runTenantJob', seller, { action: 'catalogSyncApply', tenantId: T });
  check('2. SELLER denegado también en catalogSyncApply', err === 'PERMISSION_DENIED', `err=${err}`);
}

// ═══ B. Config fail-closed ═══
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync', tenantId: T });
  check('3. Sin config ⇒ disabled (fail-closed), sin tocar Meta', result?.result?.status === 'disabled', `status=${result?.result?.status}`);
}
await setConfig({ ...VALID_CFG, sourceOfTruth: 'meta' });
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  check('4. sourceOfTruth invertida ⇒ disabled (jamás Meta→VendeyaPy)', result?.result?.status === 'disabled');
}
await setConfig({ ...VALID_CFG, mode: 'off' });
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  check('5. mode off explícito ⇒ disabled', result?.result?.status === 'disabled');
}
check('6. Ninguna corrida fail-closed dejó run docs', (await db.collection(`tenants/${T}/metaCatalogSyncRuns`).get()).empty);

// ═══ C. Dry-run: plan completo ═══
await setConfig(VALID_CFG);
let dryRun;
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  dryRun = result?.result;
  check('7. OWNER + config dry_run ⇒ planned', dryRun?.status === 'planned', `status=${dryRun?.status}`);
  check('8. producto nuevo válido ⇒ create', entryOf(dryRun, 'MCE2E-A')?.action === 'create');
  check('9. remoto idéntico (precio comparado por dígitos) ⇒ unchanged', entryOf(dryRun, 'MCE2E-B')?.action === 'unchanged');
  check('10. sin stock con item remoto ⇒ disable', entryOf(dryRun, 'MCE2E-C')?.action === 'disable');
  check('11. SKU duplicado bloquea a ambos', entryOf(dryRun, 'MCE2E-D1')?.blockedReasons?.includes('sku_duplicated') && entryOf(dryRun, 'MCE2E-D2')?.blockedReasons?.includes('sku_duplicated'));
  check('12. SKU vacío bloquea', entryOf(dryRun, 'MCE2E-E')?.blockedReasons?.includes('sku_missing'));
  check('13. imagen no-HTTPS bloquea', entryOf(dryRun, 'MCE2E-F')?.blockedReasons?.includes('image_not_https'));
  const g = entryOf(dryRun, 'MCE2E-G');
  check('14. matching por nombre = sugerencia que BLOQUEA (jamás auto-vincula)', g?.action === 'blocked' && g?.suggestion?.remoteRetailerId === 'MCE2E-HUERFANO');
  check('15. ARCHIVED con item remoto ⇒ disable (sin hard-delete)', entryOf(dryRun, 'MCE2E-ARC')?.action === 'disable');
}
{
  const run = await runDocOf(T, dryRun?.runId);
  check('16. run doc persistido con runId único y status planned', run?.status === 'planned' && run?.requestedMode === 'dry_run');
  const ro = (run?.remoteOnly ?? []).map((r) => r.retailerId);
  check('17. items solo-en-Meta reportados como remoteOnly (nunca delete)', ro.includes('MCE2E-ORPHAN2') && ro.includes('MCE2E-HUERFANO'));
  const audits = await auditsOf(T);
  check('18. auditoría meta.catalog_sync con el runId de la corrida', audits.some((a) => a.metadata?.runId === dryRun?.runId));
}

// ═══ D. Dry-run = CERO escrituras ═══
{
  check('19. cero escrituras en Meta (colección writes del fake vacía)', (await writesSnap()).empty);
  const a = await productOf('MCE2E-A');
  check('20. products sin cambios meta* tras dry-run', a?.metaSyncStatus === undefined && a?.metaCatalogId === undefined);
}

// ═══ E. Apply gateado por mode live ═══
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  check('21. apply con config dry_run ⇒ apply_blocked (mode_not_live)', result?.result?.status === 'apply_blocked' && result?.result?.reason === 'mode_not_live');
  check('22. apply bloqueado tampoco escribió en Meta', (await writesSnap()).empty);
}
await setConfig({ ...VALID_CFG, mode: 'live' });
const outboxCol = () => db.collection(`tenants/${T}/metaCatalogOutboxJobs`);
const jobsOf = async () => (await outboxCol().get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const jobOfProduct = async (pid) => (await jobsOf()).find((j) => j.productId === pid) ?? null;
const wipeOutbox = async () => { for (const d of (await outboxCol().get()).docs) await d.ref.delete(); };

let applyRun;
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  applyRun = result?.result;
  check('OB-23. confirmar el plan ENCOLA (status queued), no "aplica"', applyRun?.status === 'queued' && applyRun?.queuedCount > 0, `status=${applyRun?.status} queued=${applyRun?.queuedCount}`);
  check('OB-23b. NO se declara appliedCount ni lastSuccessfulSyncAt al encolar', applyRun?.appliedCount === undefined && !(await db.doc(`tenants/${T}/config/meta`).get()).data()?.catalogSync?.lastSuccessfulSyncAt);
  check('OB-24. encolar NO escribe NADA en Meta', (await writesSnap()).empty);
}
{
  const jobs = await jobsOf();
  const porRetailer = new Map(jobs.map((j) => [j.retailerId, j]));
  check('OB-25. un job por acción planeada (A create, C disable, ARC disable)', porRetailer.get('MCE2E-A')?.action === 'create' && porRetailer.get('MCE2E-C')?.action === 'disable' && porRetailer.get('MCE2E-ARC')?.action === 'disable', `jobs=${jobs.length}`);
  check('OB-26. los bloqueados NO se encolaron', !porRetailer.has('MCE2E-DUP') && !porRetailer.has('') && !jobs.some((j) => ['MCE2E-F', 'MCE2E-G'].includes(j.productId)));
  check('OB-27. todo job nace queued, sin handle y con intento 0', jobs.every((j) => j.status === 'queued' && j.batchHandle === null && j.attempts === 0));
  check('OB-27b. el job congela patch + hash de contenido + snapshot del producto', jobs.every((j) => !!j.intendedPatch?.id && typeof j.intendedContentHash === 'string' && j.intendedContentHash.length === 64 && typeof j.productSnapshotHash === 'string'));
  check('OB-27c. el job guarda el actor que confirmó', jobs.every((j) => typeof j.requestedByUid === 'string' && j.requestedByUid.length > 0));
  const json = JSON.stringify(jobs);
  check('OB-28. jobs SIN datos internos (aiNotes/aiFicha/costo/token)', !json.includes('SECRETO-INTERNO') && !json.includes('FICHA-INTERNA') && !/aiNotes|aiFicha|costPrice|margin|accessToken/i.test(json));
  const a = await productOf('MCE2E-A');
  check('OB-29. el producto encolado se muestra "en cola", nunca "sincronizado"', a?.metaSyncStatus === 'queued' && a?.metaCatalogId === CATALOG_ID);
}
{
  // IDEMPOTENCIA: la misma confirmación no duplica trabajo (id determinístico por contenido).
  const antes = (await jobsOf()).length;
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  const r = result?.result;
  check('OB-30. segunda confirmación idéntica ⇒ 0 nuevos, todos deduplicados', r?.queuedCount === 0 && r?.deduplicatedCount === antes, `queued=${r?.queuedCount} dedup=${r?.deduplicatedCount}`);
  check('OB-30b. la cola no creció', (await jobsOf()).length === antes);
  check('OB-30c. sigue sin haber escrituras en Meta', (await writesSnap()).empty);
}

// ═══ E2. Drenaje: recién acá se escribe en Meta ═══
{
  const r = await drain();
  check('OB-31. el drenaje reclama y envía UN lote', r?.drain?.claimed > 0 && r?.drain?.submitted === r?.drain?.claimed, JSON.stringify(r?.drain ?? {}));
  const w = (await writesSnap()).docs.map((d) => d.data());
  check('OB-32. exactamente 1 batch enviado', w.length === 1, `batches=${w.length}`);
  const reqs = w.flatMap((d) => d.requests ?? []);
  check('OB-33. métodos del contrato (CREATE/UPDATE); jamás DELETE', reqs.length > 0 && reqs.every((x) => x.method === 'CREATE' || x.method === 'UPDATE'));
  const reqA = reqs.find((x) => x.data?.id === 'MCE2E-A');
  check('OB-34. CREATE con el contrato exacto: data.id + title + link + image[] (nunca name/image_url/retailer_id)', reqA?.method === 'CREATE' && reqA?.data?.title === 'Producto MCE2E-A' && !!reqA?.data?.link && Array.isArray(reqA?.data?.image) && reqA?.data?.price === '250000 PYG' && reqA?.data?.condition === 'new' && reqA?.data?.brand === 'MarcaE2E' && !('name' in (reqA?.data ?? {})) && !('image_url' in (reqA?.data ?? {})), JSON.stringify(reqA ?? {}).slice(0, 200));
  const reqC = reqs.find((x) => x.data?.id === 'MCE2E-C');
  check('OB-35. DISABLE mínimo: SOLO id + availability out of stock', reqC?.data?.availability === 'out of stock' && Object.keys(reqC?.data ?? {}).sort().join(',') === 'availability,id', JSON.stringify(reqC?.data ?? {}));
  const jobA = await jobOfProduct('MCE2E-A');
  check('OB-36. tras enviar, el job queda ENVIADO con handle — jamás "confirmado"', jobA?.status === 'submitted' && !!jobA?.batchHandle && !!jobA?.submittedAt, `status=${jobA?.status} handle=${jobA?.batchHandle}`);
  const a = await productOf('MCE2E-A');
  check('OB-37. el usuario ve "procesando", no "sincronizado" (Meta aceptó ≠ Meta confirmó)', a?.metaSyncStatus === 'processing');
}
{
  // El fixture NO aplicó el batch ⇒ la relectura no muestra el artículo: sin evidencia, nada
  // se confirma. Es exactamente el `synced` falso que este programa vino a eliminar.
  const r = await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  const a = await productOf('MCE2E-A');
  check('OB-38. sin evidencia en la relectura, el job NO pasa a confirmado', jobA?.status === 'submitted' && a?.metaSyncStatus === 'processing', `status=${jobA?.status}`);
  check('OB-38b. tampoco se reenvía: sigue habiendo un solo batch', (await writesSnap()).size === 1 && r?.drain?.submitted === 0);
}
{
  // Ahora el fake SÍ aplica el batch (como haría Meta) y normaliza la URL igual que Meta.
  await db.doc(FIXTURE).set({ applyBatchToFixture: true }, { merge: true });
  await wipeOutbox();
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  check('OB-39. re-confirmar tras limpiar la cola vuelve a encolar', result?.result?.status === 'queued' && result?.result?.queuedCount > 0);
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  const a = await productOf('MCE2E-A');
  check('OB-40. con evidencia, el job queda CONFIRMADO y el producto sincronizado', jobA?.status === 'succeeded' && a?.metaSyncStatus === 'synced' && !!a?.metaLastSyncAt, `job=${jobA?.status} prod=${a?.metaSyncStatus}`);
  const c = await productOf('MCE2E-C');
  const jobC = await jobOfProduct('MCE2E-C');
  check('OB-40b. un disable confirmado se muestra como oculto, no como sincronizado', jobC?.status === 'succeeded' && c?.metaSyncStatus === 'disabled');
  const logA = (await db.doc(`tenants/${T}/metaCatalogSyncLogs/${jobA?.id}`).get()).data();
  check('OB-40c. log por job (id determinístico: dos drenajes no duplican historial)', logA?.status === 'success' && logA?.action === 'create');
}

{
  // EL CICLO DEL NEGOCIO: bajar el precio por promo, subirlo al terminar y volver a bajarlo
  // produce EXACTAMENTE el mismo patch que la primera vez. Con la deduplicación mirando la
  // historia, la segunda promo no llegaba nunca a Meta y el panel decía "ya estaba encolado".
  const precioDe = async (p) => (await productOf(p))?.price;
  await wipeOutbox();
  await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, applyBatchToFixture: true }, { merge: false });
  await db.doc(`tenants/${T}/products/MCE2E-B`).set({ price: 200000 }, { merge: true }); // promo
  await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  await drain();
  const promo1 = await jobOfProduct('MCE2E-B');
  await db.doc(`tenants/${T}/products/MCE2E-B`).set({ price: 250000 }, { merge: true }); // fin de promo
  await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  await drain();
  await wipe(`${FIXTURE}/writes`);
  await db.doc(`tenants/${T}/products/MCE2E-B`).set({ price: 200000 }, { merge: true }); // SEGUNDA promo
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  check('OB-30d. repetir un cambio ya aplicado antes SÍ vuelve a encolarse', (result?.result?.queuedCount ?? 0) > 0, `queued=${result?.result?.queuedCount} dedup=${result?.result?.deduplicatedCount} precio=${await precioDe('MCE2E-B')} job1=${promo1?.status}`);
  await drain();
  const reqs = (await writesSnap()).docs.flatMap((d) => d.data().requests ?? []);
  check('OB-30e. y el precio de la segunda promo LLEGA a Meta', reqs.some((x) => x.data?.id === 'MCE2E-B' && String(x.data?.price ?? '').startsWith('200000')), JSON.stringify(reqs.map((x) => [x.data?.id, x.data?.price])));
  await db.doc(`tenants/${T}/products/MCE2E-B`).set({ price: 250000 }, { merge: true });
  await wipeOutbox();
}
{
  // La confirmación es DIFERIDA: con la ventana de gracia real, un envío recién hecho no se
  // interpreta como divergencia solo porque Meta todavía no lo procesó.
  await wipeOutbox();
  await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, applyBatchToFixture: false }, { merge: false });
  await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  await drain(T, 60000); // ventana de gracia REAL
  const j = await jobOfProduct('MCE2E-A');
  check('OB-30f. un envío recién hecho NO se declara divergente por impaciencia', j?.status === 'submitted', `status=${j?.status}`);
  await wipeOutbox();
}

// ═══ E3. Gates revalidados ENTRE el encolado y el envío ═══
const reencolar = async () => {
  await wipeOutbox();
  await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, applyBatchToFixture: false }, { merge: false });
  await setConfig({ ...VALID_CFG, mode: 'live' });
  await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  await wipe(`${FIXTURE}/writes`);
};
{
  await reencolar();
  await setConfig({ ...VALID_CFG, mode: 'dry_run' });
  const r = await drain();
  check('OB-41. config en dry_run entre el encolado y el envío ⇒ CERO escrituras', (await writesSnap()).empty && r?.drain?.submitted === 0, JSON.stringify(r?.drain ?? {}));
  const retenido = await jobOfProduct('MCE2E-A');
  // El gate barato corta ANTES de reclamar: el job ni se toca. Lo que importa es que quede
  // RECUPERABLE — jamás cancelado ni fallido por haber apagado la sync un rato.
  check('OB-41b. el job queda recuperable (ni cancelado ni fallido)', (retenido?.status === 'queued' || retenido?.status === 'held') && retenido?.attempts === 0, `status=${retenido?.status} attempts=${retenido?.attempts}`);
  // Volver a `live` tiene que RECUPERAR lo retenido: un retenido sin salida sería trabajo
  // perdido en silencio cada vez que alguien apaga la sync un rato.
  await setConfig({ ...VALID_CFG, mode: 'live' });
  await drain();
  const recuperado = await jobOfProduct('MCE2E-A');
  check('OB-41c. al volver a live, lo retenido se envía (no queda muerto)', recuperado?.status === 'submitted' || recuperado?.status === 'succeeded', `status=${recuperado?.status}`);
}
{
  await reencolar();
  await db.doc(`tenants/${T}/products/MCE2E-A`).set({ syncToMeta: false }, { merge: true });
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  const reqs = (await writesSnap()).docs.flatMap((d) => d.data().requests ?? []);
  check('OB-42. opt-in revocado tras el encolado ⇒ job cancelado y el producto NO viaja', jobA?.status === 'cancelled' && jobA?.reason === 'sync_disabled' && !reqs.some((x) => x.data?.id === 'MCE2E-A'), `status=${jobA?.status}`);
  await db.doc(`tenants/${T}/products/MCE2E-A`).set({ syncToMeta: true }, { merge: true });
}
{
  await reencolar();
  await db.doc(`tenants/${T}/products/MCE2E-A`).set({ price: 999000 }, { merge: true });
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  const reqs = (await writesSnap()).docs.flatMap((d) => d.data().requests ?? []);
  check('OB-43. producto editado tras el preview ⇒ job STALE y el precio viejo JAMÁS viaja', jobA?.status === 'stale' && jobA?.reason === 'product_changed' && !reqs.some((x) => x.data?.id === 'MCE2E-A'), `status=${jobA?.status}`);
  await db.doc(`tenants/${T}/products/MCE2E-A`).set({ price: 250000 }, { merge: true });
}
{
  await reencolar();
  await setConfig({ ...VALID_CFG, mode: 'live', catalogId: 'CAT-OTRO-9' });
  const r = await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  check('OB-44. catálogo cambiado ⇒ requiere revisión, sin escribir en el catálogo nuevo', jobA?.status === 'needs_action' && jobA?.reason === 'catalog_mismatch' && (await writesSnap()).empty, `status=${jobA?.status} drain=${JSON.stringify(r?.drain ?? {})}`);
  await setConfig({ ...VALID_CFG, mode: 'live' });
}

// ═══ E4. Resultados ambiguos y errores ═══
{
  await reencolar();
  // Meta ACEPTÓ el lote y el cliente vio un timeout: el escrito PUDO haber quedado y nadie lo
  // sabe. El fixture todavía no muestra el artículo ⇒ la relectura tampoco puede confirmarlo.
  await db.doc(FIXTURE).set({ failWith: { op: 'batch', when: 'after_accept', status: 500, code: 1, message: 'timeout tras aceptar' } }, { merge: true });
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  check('OB-45. timeout DESPUÉS de que Meta aceptó ⇒ AMBIGUO, jamás "fallido"', jobA?.status === 'needs_reconciliation' && jobA?.reason === 'submit_ambiguous', `status=${jobA?.status} reason=${jobA?.reason}`);
  const batchesAntes = (await writesSnap()).size;
  // Ahora se descubre que Meta SÍ lo había aplicado (aparece al releer el catálogo).
  const items = (await db.doc(FIXTURE).get()).data()?.items ?? [];
  await db.doc(FIXTURE).set({
    failWith: null,
    items: [...items, remoteItem('MCE2E-A')],
  }, { merge: true });
  await drain();
  const jobA2 = await jobOfProduct('MCE2E-A');
  check('OB-46. la ambigüedad se resuelve MIRANDO el catálogo: quedó confirmado', jobA2?.status === 'succeeded', `status=${jobA2?.status}`);
  // El producto AMBIGUO no se reenvía. (Otros jobs del mismo lote sí pueden reintentarse: su
  // ambigüedad se resolvió como "Meta no lo tiene", y ahí el reintento es seguro.)
  const enviosA = (await writesSnap()).docs.flatMap((d) => d.data().requests ?? []).filter((x) => x.data?.id === 'MCE2E-A');
  check('OB-46b. el artículo ambiguo NO se reenvió (cero reintentos a ciegas)', enviosA.length === 1, `envíos=${enviosA.length} batchesAntes=${batchesAntes}`);
}
{
  await reencolar();
  await db.doc(FIXTURE).set({ failWith: { op: 'batch', status: 400, code: 100, message: 'campo inválido' } }, { merge: true });
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  const a = await productOf('MCE2E-A');
  check('OB-47. 4xx funcional ⇒ fallo confirmado (nada se escribió) con error saneado', jobA?.status === 'failed' && jobA?.reason === 'contract_violation' && a?.metaSyncStatus === 'failed' && String(a?.metaSyncError ?? '').length > 0, `status=${jobA?.status}`);
}
{
  await reencolar();
  await db.doc(FIXTURE).set({ failWith: { op: 'batch', status: 429, code: 4, message: 'rate limit' } }, { merge: true });
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  check('OB-48. rate limit ⇒ vuelve a la cola SIN consumir intentos ni marcar error definitivo', jobA?.status === 'queued' && jobA?.attempts === 0 && jobA?.reason === 'rate_limited', `status=${jobA?.status} attempts=${jobA?.attempts}`);
}
{
  // Un job cerrado sin éxito NO puede dejar al producto sin forma de reintentar: el id es
  // determinístico por contenido, así que sin esto la confirmación nueva caía siempre en el
  // mismo job muerto y no pasaba nada.
  await reencolar();
  await db.doc(FIXTURE).set({ failWith: { op: 'batch', status: 400, code: 100, message: 'campo inválido' } }, { merge: true });
  await drain();
  const muerto = await jobOfProduct('MCE2E-A');
  await db.doc(FIXTURE).set({ failWith: null }, { merge: true });
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  const revivido = await jobOfProduct('MCE2E-A');
  check('OB-48b. una confirmación nueva REABRE un job cerrado sin éxito', muerto?.status === 'failed' && revivido?.status === 'queued' && revivido?.attempts === 0 && (result?.result?.queuedCount ?? 0) > 0, `antes=${muerto?.status} después=${revivido?.status}`);
  check('OB-48c. y sigue habiendo UN solo job para ese producto (no se duplicó)', (await jobsOf()).filter((j) => j.productId === 'MCE2E-A').length === 1);
  await drain();
  const ok = await jobOfProduct('MCE2E-A');
  check('OB-48d. el reintento explícito llega a enviarse', ok?.status === 'submitted' || ok?.status === 'succeeded' || ok?.status === 'needs_reconciliation', `status=${ok?.status}`);
}
{
  await reencolar();
  await db.doc(FIXTURE).set({ applyBatchToFixture: true, failWith: null, batchStatusErrors: [{ retailer_id: 'MCE2E-A', message: 'imagen rechazada por Meta' }] }, { merge: true });
  await drain();
  const jobA = await jobOfProduct('MCE2E-A');
  const jobC = await jobOfProduct('MCE2E-C');
  const a = await productOf('MCE2E-A');
  check('OB-49. un item rechazado por Meta cae SOLO (el resto del lote se confirma igual)', jobA?.status === 'failed' && jobA?.reason === 'item_rejected' && String(a?.metaSyncError ?? '').includes('imagen rechazada') && jobC?.status === 'succeeded', `A=${jobA?.status} C=${jobC?.status}`);
  await db.doc(FIXTURE).set({ batchStatusErrors: [] }, { merge: true });
}
{
  // URL ausente en la relectura ⇒ unverifiable: NUNCA se declara sincronizado.
  await reencolar();
  await db.doc(FIXTURE).set({
    applyBatchToFixture: false,
    items: FIXTURE_ITEMS.map((i) => (i.retailer_id === 'MCE2E-C' ? { ...i, availability: 'out of stock', url: '' } : i)),
  }, { merge: true });
  await drain();
  await drain();
  const jobC = await jobOfProduct('MCE2E-C');
  check('OB-50. sin `url` en la lectura de Meta, el disable igual se confirma (no manda link)', jobC?.status === 'succeeded', `status=${jobC?.status}`);
  const jobA = await jobOfProduct('MCE2E-A');
  check('OB-50b. un CREATE cuyo artículo no aparece al releer NUNCA queda confirmado', jobA?.status !== 'succeeded', `status=${jobA?.status}`);
}
{
  // Dos drenajes CONCURRENTES: el claim transaccional garantiza un solo envío.
  await reencolar();
  await db.doc(FIXTURE).set({ applyBatchToFixture: true }, { merge: true });
  await Promise.all([drain(), drain()]);
  const reqs = (await writesSnap()).docs.flatMap((d) => d.data().requests ?? []);
  const idsA = reqs.filter((x) => x.data?.id === 'MCE2E-A');
  check('OB-51. dos drenajes concurrentes ⇒ el producto se envía UNA sola vez', idsA.length === 1, `envíos=${idsA.length}`);
}
{
  // Worker zombi: un job "en vuelo" con lease vencido lo normaliza el sweep a ambiguo, y el
  // worker viejo ya no puede asentar nada sobre él.
  await reencolar();
  const jobA = await jobOfProduct('MCE2E-A');
  await db.doc(`tenants/${T}/metaCatalogOutboxJobs/${jobA.id}`).set({
    status: 'processing', attempts: 1, leaseOwner: 'zombi', leaseUntil: Timestamp.fromMillis(Date.now() - 60_000),
  }, { merge: true });
  await drain();
  const tras = await jobOfProduct('MCE2E-A');
  check('OB-52. lease vencido ⇒ el job queda para reconciliar (nunca se reenvía a ciegas)', tras?.status === 'needs_reconciliation' || tras?.status === 'succeeded', `status=${tras?.status}`);
  const antes = tras?.updatedAt?.toMillis?.() ?? 0;
  await db.doc(`tenants/${T}/metaCatalogOutboxJobs/${jobA.id}`).set({ status: 'succeeded', attempts: 1 }, { merge: true });
  const w1 = (await writesSnap()).size;
  await drain();
  check('OB-52b. un job terminal no se vuelve a tocar ni a enviar', (await writesSnap()).size === w1 && antes >= 0);
}
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, failWith: { op: 'getCatalog', status: 400, code: 100, message: 'Unsupported get request' } });
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  const r = result?.result;
  check('OB-53. catálogo inaccesible ⇒ error catalog_unreachable (sin crash)', r?.status === 'error' && r?.reason === 'catalog_unreachable');
}
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS });
await wipeOutbox();
await wipe(`${FIXTURE}/writes`);

// ═══ G. Aislamiento de tenant ═══
{
  const { result } = await call('runTenantJob', ownerBoutique, { action: 'catalogSync', tenantId: T });
  // resolvePanelAuth ignora el tenantId ajeno para OWNER: corre sobre SU tenant (sin config ⇒ disabled).
  check('41. OWNER de otro tenant no puede correr la sync de perfumería', result?.result?.status === 'disabled');
  const x = await productOf('MCE2E-X') ?? (await db.doc(`tenants/${T2}/products/MCE2E-X`).get()).data();
  check('42. productos del otro tenant intactos (sin meta*)', x?.metaSyncStatus === undefined);
  check('43. cero runs en el tenant sin config (análogo credipower)', (await db.collection(`tenants/${T2}/metaCatalogSyncRuns`).get()).empty);
}
{
  const { result } = await call('runTenantJob', admin, { action: 'catalogSync', tenantId: T });
  check('44. PLATFORM_ADMIN sí opera el tenant explícito', result?.result?.status === 'planned');
}

// ═══ H. Entitlements ═══
await db.doc(`tenants/${T}`).set({ planId: 'starter' }, { merge: true }); // starter NO tiene marketingAutomation
// resolveEntitlements cachea 30s en memoria: esperar a que expire para ver el plan nuevo.
console.log('   (esperando 31s a que expire la cache de entitlements…)');
await new Promise((r) => setTimeout(r, 31_000));
{
  const { err } = await call('runTenantJob', owner, { action: 'catalogSync' });
  check('45. sin feature marketingAutomation ⇒ bloqueado por entitlements', err !== null, `err=${err}`);
}
await db.doc(`tenants/${T}`).set({ planId: 'growth' }, { merge: true });

// ═══ I. RECONCILIACIÓN (META-CATALOG-RECONCILIATION-1) ═══
// La sección H dejó el plan 'starter' en la cache de entitlements (TTL 30s): esperar a que
// expire para que los callables de esta sección vean el plan growth restaurado.
console.log('   (esperando 31s a que expire la cache de entitlements…)');
await new Promise((r) => setTimeout(r, 31_000));
await db.doc(`tenants/${T}/categories/perfumes`).set({ id: 'perfumes', tenantId: T, name: 'Perfumes', isActive: true, position: 0, ...TS }, { merge: true });
// Producto sin opt-in: representa a un importado. NO debe generar acción ninguna.
await db.doc(`tenants/${T}/products/MCE2E-IMP`).set(prodDoc('MCE2E-IMP', {
  status: 'INACTIVE', syncToMeta: false, metaRetailerId: 'MCE2E-HUERFANO',
  inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: 'MCE2E-HUERFANO' },
}));
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  const r = result?.result;
  check('46. importado INACTIVE + syncToMeta:false ⇒ excluido del plan (ni una entrada)', !entryOf(r, 'MCE2E-IMP'));
  check('47. EL INVARIANTE: ese importado JAMÁS genera disable', !(r?.entries ?? []).some((e) => e.productId === 'MCE2E-IMP' && e.action === 'disable'));
  check('48. el plan reporta cuántos productos quedaron fuera por falta de opt-in', (r?.excludedNotManaged ?? 0) >= 1, `excluidos=${r?.excludedNotManaged}`);
  check('49. su artículo mapeado deja de figurar como candidato de importación', !(r?.remoteOnly ?? []).some((x) => x.retailerId === 'MCE2E-HUERFANO'));
}
{
  const { err } = await call('metaCatalogConfirmMapping', seller, { tenantId: T, productId: 'MCE2E-A', retailerId: 'MCE2E-ORPHAN2' });
  check('50. SELLER denegado en confirmar mapping', err === 'PERMISSION_DENIED', `err=${err}`);
}
const writesAntesMapping = (await writesSnap()).size;
{
  const { result } = await call('metaCatalogConfirmMapping', owner, { productId: 'MCE2E-A', retailerId: 'MCE2E-ORPHAN2' });
  check('51. OWNER confirma el mapping', result?.ok === true && result?.alreadyMapped === false);
  const a = await productOf('MCE2E-A');
  check('52. guarda metaRetailerId + metaProductItemId + metaCatalogId', a?.metaRetailerId === 'MCE2E-ORPHAN2' && a?.metaProductItemId === 'itm-MCE2E-ORPHAN2' && a?.metaCatalogId === CATALOG_ID);
  // MCE2E-A ya venía sincronizando: confirmar el vínculo NO debe sacarlo del plan en silencio
  // (apagarlo dejaría de propagar sus cambios a Meta sin que nadie lo pida).
  check('53. el vínculo PRESERVA el opt-in de un producto que ya sincronizaba', a?.syncToMeta === true);
  check('54. NO toca precio, SKU ni status', a?.price === 250000 && a?.inventory?.sku === 'MCE2E-A' && a?.status === 'ACTIVE');
  check('55. cero escrituras en Meta por confirmar un mapping', (await writesSnap()).size === writesAntesMapping, `antes=${writesAntesMapping} ahora=${(await writesSnap()).size}`);
  const audits = (await db.collection(`tenants/${T}/auditLogs`).where('action', '==', 'meta.catalog_mapping_confirmed').get()).docs;
  check('56. auditoría del mapping con actor', audits.length === 1 && !!audits[0].data().actorUid);
}
{
  const { result } = await call('metaCatalogConfirmMapping', owner, { productId: 'MCE2E-A', retailerId: 'MCE2E-ORPHAN2' });
  check('57. re-confirmar el MISMO mapping es idempotente', result?.ok === true && result?.alreadyMapped === true);
}
{
  // Un producto que NO estaba sincronizando: el vínculo tampoco lo habilita (fail-closed).
  await db.doc(`tenants/${T}/products/MCE2E-NOSYNC`).set(prodDoc('MCE2E-NOSYNC', { syncToMeta: false }));
  const { result } = await call('metaCatalogConfirmMapping', owner, { productId: 'MCE2E-NOSYNC', retailerId: 'MCE2E-HUERFANO' });
  const p = await productOf('MCE2E-NOSYNC');
  check('57b. el vínculo NO habilita la sync de un producto que no la tenía', result?.ok === true && p?.syncToMeta === false && p?.metaRetailerId === 'MCE2E-HUERFANO');
}
{
  const { err } = await call('metaCatalogConfirmMapping', owner, { productId: 'MCE2E-A', retailerId: 'MCE2E-B' });
  check('58. cambiar el mapping a otro artículo se RECHAZA (inmutable)', err === 'FAILED_PRECONDITION', `err=${err}`);
}
{
  const { err } = await call('metaCatalogConfirmMapping', owner, { productId: 'MCE2E-B', retailerId: 'MCE2E-ORPHAN2' });
  check('59. un retailer_id ya vinculado no se puede reusar en otro producto', err === 'FAILED_PRECONDITION', `err=${err}`);
}
{
  const { err } = await call('metaCatalogConfirmMapping', owner, { productId: 'MCE2E-B', retailerId: 'NO-EXISTE-EN-META' });
  check('60. no se vincula contra un artículo inexistente en Meta', err === 'NOT_FOUND', `err=${err}`);
}
{
  const { result } = await call('metaCatalogReconcilePlan', owner, {});
  check('61. el plan de reconciliación lista candidatos y artículos sin vincular', result?.ok === true && Array.isArray(result?.unlinked));
  check('62. los ya vinculados figuran como linked', (result?.linked ?? []).some((l) => l.retailerId === 'MCE2E-ORPHAN2'));
  check('63. el catalogId viaja ENMASCARADO', typeof result?.catalogIdMasked === 'string' && result.catalogIdMasked.startsWith('…'));
  const json = JSON.stringify(result);
  check('64. el plan NO expone datos internos (aiNotes/aiFicha/costos)', !json.includes('SECRETO-INTERNO') && !json.includes('FICHA-INTERNA') && !/costPrice/i.test(json));
}
{
  const { err } = await call('metaCatalogImportItems', seller, { tenantId: T, retailerIds: ['MCE2E-B'], categoryId: 'perfumes' });
  check('65. SELLER denegado en importar', err === 'PERMISSION_DENIED', `err=${err}`);
}
{
  const { result } = await call('metaCatalogImportItems', owner, { retailerIds: ['MCE2E-B'], categoryId: '' });
  check('66. sin categoría explícita el candidato queda BLOQUEADO (no se inventa)', result?.ok === false && result?.blocked?.[0]?.reason === 'category_required');
}
let importedId = null;
{
  const { result } = await call('metaCatalogImportItems', owner, { retailerIds: ['MCE2E-C'], categoryId: 'perfumes' });
  // MCE2E-C ya existe como SKU local ⇒ debe bloquearse por duplicado.
  check('67. artículo cuyo SKU ya existe localmente ⇒ bloqueado (no duplica)', result?.blocked?.some((b) => b.reason === 'already_imported'), JSON.stringify(result?.blocked ?? []));
}
{
  const { result } = await call('metaCatalogImportItems', owner, { retailerIds: ['MCE2E-ORPHAN2'], categoryId: 'perfumes' });
  check('68. artículo ya mapeado ⇒ bloqueado', result?.blocked?.some((b) => b.reason === 'already_mapped'));
}
{
  await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: [...FIXTURE_ITEMS, remoteItem('MCE2E-NUEVO', { name: 'Artículo Nuevo Meta', brand: 'MarcaX' })] });
  const { result } = await call('metaCatalogImportItems', owner, { retailerIds: ['MCE2E-NUEVO'], categoryId: 'perfumes' });
  importedId = result?.imported?.[0]?.productId ?? null;
  check('69. importación exitosa de un artículo nuevo', result?.ok === true && !!importedId);
  const p = importedId ? (await db.doc(`tenants/${T}/products/${importedId}`).get()).data() : null;
  check('70. el importado nace INACTIVE', p?.status === 'INACTIVE');
  check('71. el importado nace con syncToMeta=false (no puede tocar Meta)', p?.syncToMeta === false);
  check('72. conserva el retailer_id de Meta como identidad', p?.metaRetailerId === 'MCE2E-NUEVO');
  check('73. NO inventa stock (trackStock=false + pendiente de revisión)', p?.inventory?.trackStock === false && p?.stockPendingReview === true);
  check('74. NO crea productFinancials (el costo queda desconocido)', !(await db.doc(`tenants/${T}/productFinancials/${importedId}`).get()).exists);
  check('75. importa campos públicos (precio parseado, imagen, marca)', p?.price === 250000 && p?.images?.[0] === IMG && p?.perfume?.brand === 'MarcaX');
}
{
  const { result } = await call('metaCatalogImportItems', owner, { retailerIds: ['MCE2E-NUEVO'], categoryId: 'perfumes' });
  check('76. re-importar el mismo artículo es idempotente (bloqueado, sin duplicar)', result?.blocked?.length === 1 && !result?.imported?.length);
  const dup = (await db.collection(`tenants/${T}/products`).where('metaRetailerId', '==', 'MCE2E-NUEVO').get()).size;
  check('77. sigue existiendo UN solo producto para ese artículo', dup === 1, `docs=${dup}`);
}
{
  const antes = (await writesSnap()).size;
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  const r = result?.result;
  check('78. el importado NO aparece en el plan de sync', !entryOf(r, importedId));
  check('79. el dry-run posterior no escribió en Meta', (await writesSnap()).size === antes);
}
{
  const { result } = await call('metaCatalogSetSyncEnabled', owner, { productId: importedId, enabled: true });
  check('80. habilitar un importado se RECHAZA por los gates (INACTIVE + stock sin validar)', result?.ok === false && result?.blockers?.includes('not_active') && result?.blockers?.includes('stock_pending_review'));
}
{
  // El stock se revisa editando el producto: eso limpia stockPendingReview (sin esto, un
  // importado quedaría bloqueado para siempre).
  const { err } = await call('productUpsert', owner, { id: importedId, data: { inventory: { trackStock: true, stock: 7, lowStockThreshold: 1, sku: 'MCE2E-NUEVO' } } });
  const p = (await db.doc(`tenants/${T}/products/${importedId}`).get()).data();
  check('80b. editar el inventario limpia stockPendingReview', err === null && p?.stockPendingReview === false, `err=${err} flag=${p?.stockPendingReview}`);
  const { result } = await call('metaCatalogSetSyncEnabled', owner, { productId: importedId, enabled: true });
  check('80c. tras revisar el stock, el único bloqueo que queda es que está INACTIVE', result?.ok === false && result?.blockers?.includes('not_active') && !result?.blockers?.includes('stock_pending_review'), JSON.stringify(result?.blockers ?? []));
}
{
  const { err } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'MCE2E-B' });
  check('80d. omitir `enabled` es invalid-argument (no apaga la sync por accidente)', err === 'INVALID_ARGUMENT', `err=${err}`);
}
{
  const { err } = await call('metaCatalogSetSyncEnabled', seller, { tenantId: T, productId: importedId, enabled: true });
  check('81. SELLER denegado en habilitar sync', err === 'PERMISSION_DENIED', `err=${err}`);
}
{
  // MCE2E-A: activo, con marca, categoría, imagen HTTPS y vínculo confirmado ⇒ sin bloqueos.
  const { result: sinConfirmar } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'MCE2E-A', enabled: true });
  check('82. habilitar exige confirmación explícita del diff', sinConfirmar?.ok === false && sinConfirmar?.requiresConfirmation === true, `intent=${sinConfirmar?.intent} blockers=${JSON.stringify(sinConfirmar?.blockers ?? [])}`);
  check('82b. el diff declara que va a ACTUALIZAR (producto mapeado)', sinConfirmar?.intent === 'update');
  const { result: confirmado } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'MCE2E-A', enabled: true, confirmDiff: true });
  check('83. con confirmación explícita, se habilita', confirmado?.ok === true && confirmado?.enabled === true);
  const p = await productOf('MCE2E-A');
  check('84. el producto queda con syncToMeta=true', p?.syncToMeta === true);
}
{
  const crediProds = await db.collection(`tenants/${T2}/products`).get();
  check('85. credipower intacto tras toda la reconciliación', crediProds.docs.every((d) => !d.data().metaRetailerId));
  const crediRuns = await db.collection(`tenants/${T2}/metaCatalogSyncRuns`).get();
  check('86. cero runs en credipower', crediRuns.empty);
}
{
  const { err } = await call('metaCatalogConfirmMapping', ownerBoutique, { tenantId: T, productId: 'MCE2E-B', retailerId: 'MCE2E-ORPHAN2' });
  check('87. OWNER de otro tenant no puede mapear productos ajenos', err === 'NOT_FOUND' || err === 'FAILED_PRECONDITION', `err=${err}`);
}
{
  // El lock de unicidad vive en el tenant y sobrevive a la corrida: confirma que el vínculo
  // quedó reservado (es lo que impide que dos productos reclamen el mismo artículo).
  const locks = await db.collection(`tenants/${T}/metaRetailerLocks`).get();
  check('88. el vínculo confirmado dejó su lock de unicidad', locks.docs.some((d) => d.data().retailerId === 'MCE2E-ORPHAN2' && d.data().productId === 'MCE2E-A'), `locks=${locks.size}`);
}
{
  // Un producto cuyo SKU coincide con un artículo vivo de Meta, SIN vínculo confirmado:
  // habilitarlo reclamaría ese artículo a ciegas ⇒ debe bloquearse.
  await db.doc(`tenants/${T}/products/MCE2E-SKUCHOQUE`).set(prodDoc('MCE2E-SKUCHOQUE', {
    syncToMeta: false, perfume: { brand: 'X' }, inventory: INV('MCE2E-B', 5),
  }));
  const { result } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'MCE2E-SKUCHOQUE', enabled: true });
  check('89. SKU que ya existe en Meta sin vínculo confirmado ⇒ unconfirmed_remote_match', result?.ok === false && result?.blockers?.includes('unconfirmed_remote_match'), JSON.stringify(result?.blockers ?? []));
  await db.doc(`tenants/${T}/products/MCE2E-SKUCHOQUE`).delete();
}
{
  // ── URL: Meta normaliza lo que recibe (barra final, host en minúsculas, escapes).
  // Comparar strings crudos produciría un UPDATE en CADA corrida que nunca converge.
  const rid = 'MCE2E-URLNORM';
  await db.doc(`tenants/${T}/products/${rid}`).set(prodDoc(rid, {
    productUrl: 'https://TIENDA.e2e.test/p/uno dos', metaRetailerId: rid, inventory: INV(rid, 5),
  }));
  await db.doc(FIXTURE).set({
    catalog: { id: CATALOG_ID, name: 'Catálogo E2E' },
    items: [remoteItem(rid, { url: 'https://tienda.e2e.test/p/uno%20dos' })],
  });
  await setConfig(VALID_CFG);
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  const e = entryOf(result?.result, rid);
  check('90. una URL que Meta ya normalizó NO genera un update perpetuo', e?.action === 'unchanged', `action=${e?.action} changed=${JSON.stringify(e?.changedFields ?? [])}`);
  await db.doc(`tenants/${T}/products/${rid}`).delete();
}

// ═══ Resultado ═══
const okCount = results.filter(Boolean).length;
console.log(`\nRESULTADO META-CATALOG (E2E fake): ${okCount === results.length ? 'TODO OK ✅' : 'FALLAS ❌'} (${okCount}/${results.length})`);
process.exit(okCount === results.length ? 0 : 1);
