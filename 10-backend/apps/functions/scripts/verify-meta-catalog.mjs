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

const now = Timestamp.now();
const TS = { createdAt: now, updatedAt: now };
const INV = (sku, stock = 5) => ({ trackStock: true, stock, lowStockThreshold: 1, sku });
const IMG = 'https://cdn.e2e.test/mce2e.jpg';
const prodDoc = (id, over = {}) => ({
  id, tenantId: T, name: `Producto ${id}`, description: `Descripción pública de ${id}`,
  price: 250000, compareAtPrice: null, aiNotes: `SECRETO-INTERNO-${id}`, currency: 'PYG',
  categoryId: 'perfumes', images: [IMG], emoji: '🌸', inventory: INV(id),
  status: 'ACTIVE', featured: false, position: 90, externalIds: { facebook: null, instagram: null, tiktok: null },
  perfume: null, aiFicha: { cuandoRecomendar: `FICHA-INTERNA-${id}` }, ...TS, ...over,
});
const remoteItem = (retailerId, over = {}) => ({
  id: `itm-${retailerId}`, retailer_id: retailerId, name: `Producto ${retailerId}`,
  description: `Descripción pública de ${retailerId}`, availability: 'in stock',
  price: '₲250.000', image_url: IMG, brand: '', ...over,
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
await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set({
  name: 'Perfumería E2E', slug: T, status: 'ACTIVE', planId: 'growth',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
  updatedAt: now,
}, { merge: true });
await db.doc(`tenants/${T2}`).set({ name: 'Boutique E2E', slug: T2, status: 'ACTIVE', planId: 'growth', subscription: { status: 'active', currentPeriodStart: now }, updatedAt: now }, { merge: true });

// Productos controlados MCE2E-* (los del seed load-catalog, si existen, no participan de los asserts).
await db.doc(`tenants/${T}/products/MCE2E-A`).set(prodDoc('MCE2E-A', { perfume: { brand: 'Armaf' } }));      // create
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
let applyRun;
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  applyRun = result?.result;
  check('23. apply con mode live ⇒ applied', applyRun?.status === 'applied', `status=${applyRun?.status} reason=${applyRun?.reason ?? ''}`);
}
{
  const w = (await writesSnap()).docs.map((d) => d.data());
  check('24. exactamente 1 batch enviado', w.length === 1, `batches=${w.length}`);
  const reqs = w.flatMap((d) => d.requests ?? []);
  check('25. todos los requests son UPDATE (upsert); jamás DELETE', reqs.length > 0 && reqs.every((r) => r.method === 'UPDATE'));
  const ids = reqs.map((r) => r.retailer_id);
  check('26. el batch incluye create+disable planeados (A, C, ARC)', ids.includes('MCE2E-A') && ids.includes('MCE2E-C') && ids.includes('MCE2E-ARC'));
  check('27. los bloqueados NO viajaron a Meta', !ids.includes('MCE2E-DUP') && !ids.includes('') && !ids.some((i) => ['MCE2E-F', 'MCE2E-G'].includes(i)));
  const json = JSON.stringify(reqs);
  check('28. payloads SIN datos internos (aiNotes/aiFicha/costo)', !json.includes('SECRETO-INTERNO') && !json.includes('FICHA-INTERNA') && !/aiNotes|aiFicha|costPrice|margin/i.test(json));
  const reqA = reqs.find((r) => r.retailer_id === 'MCE2E-A');
  check('29. payload público exacto con precio "N PYG" y condition new (retailer_id fuera del data)', reqA?.data?.price === '250000 PYG' && reqA?.data?.condition === 'new' && reqA?.data?.brand === 'Armaf' && reqA?.data?.availability === 'in stock' && !('retailer_id' in (reqA?.data ?? {})));
  const reqC = reqs.find((r) => r.retailer_id === 'MCE2E-C');
  check('30. disable viaja como availability "out of stock" (no delete)', reqC?.data?.availability === 'out of stock');
}
{
  const a = await productOf('MCE2E-A');
  // El fake no "aplica" el batch al fixture ⇒ el create no aparece al releer: queda pending.
  check('31. create no visible al releer ⇒ metaSyncStatus pending (verificación honesta)', a?.metaSyncStatus === 'pending' && a?.metaCatalogId === CATALOG_ID);
  const c = await productOf('MCE2E-C');
  // El fake no aplica el batch: al releer, el item sigue "in stock" ⇒ el disable NO se
  // declara confirmado (queda pending y converge cuando Meta lo procese de verdad).
  check('32. disable no confirmado al releer ⇒ pending (jamás un disabled falso)', c?.metaSyncStatus === 'pending' && c?.metaProductItemId === 'itm-MCE2E-C');
  const b = await productOf('MCE2E-B');
  check('33. unchanged con remoto converge a synced en apply', b?.metaSyncStatus === 'synced' && b?.metaProductItemId === 'itm-MCE2E-B');
  const logA = (await db.doc(`tenants/${T}/metaCatalogSyncLogs/${applyRun?.runId}_MCE2E-A`).get()).data();
  check('34. log por producto con id runId_productId', logA?.status === 'success' && logA?.action === 'create');
  const cfgAfter = (await db.doc(`tenants/${T}/config/meta`).get()).data();
  check('35. lastSuccessfulSyncAt sellado tras apply exitoso', !!cfgAfter?.catalogSync?.lastSuccessfulSyncAt);
}

// Idempotencia: segundo apply produce el mismo conjunto de upserts (sin drift ni deletes).
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  check('36. segundo apply ⇒ applied (idempotente)', result?.result?.status === 'applied');
  const w = (await writesSnap()).docs.map((d) => d.data());
  const ids1 = (w[0]?.requests ?? []).map((r) => r.retailer_id).sort();
  const ids2 = (w[1]?.requests ?? []).map((r) => r.retailer_id).sort();
  check('37. mismos retailer_ids en ambos applies (upserts estables)', w.length === 2 && JSON.stringify(ids1) === JSON.stringify(ids2));
}

// ═══ F. Fallas de la API ═══
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, failWith: { op: 'batch', status: 500, code: 1, message: 'transient' } });
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  const r = result?.result;
  check('38. batch 5xx ⇒ partial_failure con reason batch_failed', r?.status === 'partial_failure' && r?.reason === 'batch_failed');
  const a = await productOf('MCE2E-A');
  check('39. productos del batch fallido quedan failed con error saneado', a?.metaSyncStatus === 'failed' && typeof a?.metaSyncError === 'string' && a.metaSyncError.length > 0);
}
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, failWith: { op: 'getCatalog', status: 400, code: 100, message: 'Unsupported get request' } });
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSync' });
  const r = result?.result;
  check('40. catálogo inaccesible ⇒ error catalog_unreachable (sin crash)', r?.status === 'error' && r?.reason === 'catalog_unreachable');
}
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS, batchStatusErrors: [{ retailer_id: 'MCE2E-A', message: 'imagen rechazada por Meta' }] });
{
  const { result } = await call('runTenantJob', owner, { action: 'catalogSyncApply' });
  const r = result?.result;
  check('40b. error por item del batch asíncrono ⇒ partial_failure', r?.status === 'partial_failure' && r?.reason === 'batch_failed');
  const a = await productOf('MCE2E-A');
  check('40c. el producto rechazado queda failed con el mensaje de Meta', a?.metaSyncStatus === 'failed' && String(a?.metaSyncError ?? '').includes('imagen rechazada'));
}
await db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo E2E' }, items: FIXTURE_ITEMS });

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

// ═══ Resultado ═══
const okCount = results.filter(Boolean).length;
console.log(`\nRESULTADO META-CATALOG (E2E fake): ${okCount === results.length ? 'TODO OK ✅' : 'FALLAS ❌'} (${okCount}/${results.length})`);
process.exit(okCount === results.length ? 0 : 1);
