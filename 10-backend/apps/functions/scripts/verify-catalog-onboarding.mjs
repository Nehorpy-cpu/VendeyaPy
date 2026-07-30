/**
 * verify-catalog-onboarding.mjs — META-CATALOG-GENERIC-ONBOARDING-QUALITY-1 (emulador limpio).
 * Importación PAGINADA/reanudable del catálogo de Meta + centro de calidad, con cliente FAKE
 * por fixtures (JAMÁS Meta real, cero escrituras hacia el catálogo):
 *   catálogo vacío / 1 página / multi-página / >500 items, cursor inválido con reset,
 *   reanudación con progreso persistido, fallo parcial con cursor guardado, concurrencia
 *   (already_running por lease), idempotencia total, aislamiento entre tenants con MISMOS
 *   retailer_ids, clasificación (ambiguo/duplicado/sin categoría/genérico/precio/imagen/
 *   ya vinculado), gates de calidad sobre setSyncEnabled, corrección vía productUpsert con
 *   resolvedAt sellado, campana agregada única con autocierre, roles, rules y vendibilidad.
 *
 * (HARDEN-1) Sección HD al final: mantenimiento del catálogo (preview sin escrituras / apply
 * confirmado con backfill de locks+quality, conflictos sin ganador, reanudación idempotente,
 * roles), import clásico con lock por ítem + perfiles por vertical, fencing generacional del
 * run de importación (zombi con generación superada no escribe NADA) y query de la campana
 * catalog_quality bajo rules.
 *
 * Requiere: emuladores (auth+functions+firestore) + seed-users + load-catalog.
 * Checks numerados CO-N / HD-N (uno por punto del programa; letras = sub-asserts).
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const adminAuth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria';
const T2 = 'boutique-demo';
const CATALOG_ID = 'CAT-ONB-1';
const FIXTURE = 'metaTestFixtures/catalog';
/**
 * (ADR-0015) `ownership` es OBLIGATORIA: sin ella la config queda con propiedad DEGRADADA
 * —cero campos escribibles, techo `dry_run`— y el opt-in de sincronización se bloquea. Este
 * escenario describe un tenant que administra sus propios campos públicos, así que declara
 * la matriz completa. `sourceOfTruth` queda como literal legacy (ya no decide nada).
 */
const OWNED_FIELDS = ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'];
const CFG = { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, sourceOfTruth: 'vendeyapy', ownership: { model: 'vendeyapy_managed', ownedFields: OWNED_FIELDS, external: null } };

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, errMsg: body.error?.message ?? null };
}
// El "cliente" de las pruebas de rules ES la API REST de Firestore con el idToken del usuario
// (mismo criterio que verify-rules-catalog.mjs): 403 = las rules lo negaron.
const restGet = (path, token) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
const restPatch = (path, fields, token) => fetch(`${FS}/${path}?${Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join('&')}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fields }) }).then((r) => r.status);

const now = Timestamp.now();
const COUNTER_KEYS = ['imported', 'alreadyLinked', 'alreadyImported', 'ambiguous', 'conflicted', 'skipped', 'unclassified', 'cursorResets'];
const countersStr = (c) => COUNTER_KEYS.map((k) => `${k}=${c?.[k] ?? 0}`).join(' ');
const countersEq = (c, exp) => COUNTER_KEYS.every((k) => (c?.[k] ?? 0) === (exp[k] ?? 0));

// ── Helpers de fixture (espejan el contrato de LECTURA del Graph: snake_case) ──
const IMG = (rid) => `https://cdn.e2e.test/onb/${rid}.jpg`;
const item = (rid, over = {}) => ({
  id: `itm-${rid}`, retailer_id: rid, name: `Articulo ${rid}`, description: `Articulo ${rid} de prueba`,
  availability: 'in stock', price: '₲150.000', image_url: IMG(rid), brand: 'MarcaOnb',
  url: `https://tienda.e2e.test/i/${rid}`, condition: 'new', ...over,
});
const setFixture = (items, extra = {}) =>
  db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo Onboarding E2E' }, items, ...extra }); // sin merge: mata pagesPerList/failWith viejos
const writesSnap = () => db.collection(`${FIXTURE}/writes`).get();

// ── Helpers de lectura/limpieza ──
const productOf = async (tenant, id) => (await db.doc(`tenants/${tenant}/products/${id}`).get()).data() ?? null;
const runDocOf = async (tenant, runId) => (await db.doc(`tenants/${tenant}/metaCatalogImportRuns/${runId}`).get()).data() ?? null;
const stateOf = async (tenant) => (await db.doc(`tenants/${tenant}/metaCatalogImportState/current`).get()).data() ?? null;
const notifOf = async (tenant) => (await db.doc(`tenants/${tenant}/notifications/catalog-quality-${tenant}`).get()).data() ?? null;
const obsOf = (q, code) => Object.values(q?.fingerprints ?? {}).find((o) => o.code === code) ?? null;
const obsActiva = (q, code) => { const o = obsOf(q, code); return !!o && o.resolvedAt === null; };

async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = db.batch();
    for (const r of refs.slice(i, i + 400)) b.delete(r);
    await b.commit();
  }
}
// 'meta_' entero: TODO importado es un artefacto de harness (los seeds no usan ese prefijo).
// Cubre también residuos de verify-meta-catalog (p.ej. meta_MCE2E-NUEVO, que termina su
// corrida CON quality vía productUpsert y falsearía los agregados de calidad de este script).
const MIS_PREFIJOS = ['meta_', 'ONB-LOCAL-', 'ptest-', 'hdm-'];
/** Borra products/locks/runs/state del programa en un tenant (idempotente, re-corrible). */
async function wipeImportArtifacts(tenant, { keepLocals = false } = {}) {
  const prods = await db.collection(`tenants/${tenant}/products`).get();
  const objetivo = prods.docs.filter((d) => MIS_PREFIJOS.some((p) => d.id.startsWith(p)) && !(keepLocals && d.id.startsWith('ONB-LOCAL-')));
  await deleteRefs(objetivo.map((d) => d.ref));
  await deleteRefs((await db.collection(`tenants/${tenant}/metaRetailerLocks`).get()).docs.map((d) => d.ref));
  await deleteRefs((await db.collection(`tenants/${tenant}/metaCatalogImportRuns`).get()).docs.map((d) => d.ref));
  await deleteRefs((await db.collection(`tenants/${tenant}/metaCatalogMaintenanceRuns`).get()).docs.map((d) => d.ref)); // HARDEN-1
  await db.doc(`tenants/${tenant}/metaCatalogImportState/current`).delete().catch(() => {});
}
async function wipePrograma() {
  for (const tenant of [T, T2]) {
    await wipeImportArtifacts(tenant);
    await deleteRefs((await db.collection(`tenants/${tenant}/notifications`).where('category', '==', 'catalog_quality').get()).docs.map((d) => d.ref));
  }
  await db.doc(`tenants/${T2}/config/meta`).delete().catch(() => {});
  await db.doc(`tenants/${T2}/categories/general`).delete().catch(() => {});
}

// ═══ Setup ═══
console.log('\n═══ META-CATALOG-GENERIC-ONBOARDING-QUALITY-1 · E2E con cliente fake (cero Meta real) ═══\n');
await wipePrograma(); // re-corrible sin reiniciar el emulador

// Tenants con plan/billing operativos (los seeds no traen planId) + cuota holgada para >500.
const tenantBase = (id, name) => ({
  name, slug: id, status: 'ACTIVE', planId: 'growth',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
  limitOverrides: { maxProducts: 100000 },
  updatedAt: now,
});
await db.doc(`tenants/${T}`).set(tenantBase(T, 'Perfumería E2E'), { merge: true });
await db.doc(`tenants/${T2}`).set(tenantBase(T2, 'Boutique E2E'), { merge: true });
await db.doc(`tenants/${T}/config/meta`).set({ catalogSync: CFG }, { merge: true });
await db.doc(`tenants/${T2}/config/meta`).set({ catalogSync: CFG }, { merge: true });
// HARDEN-1: el tenant "perfumeria" del E2E lleva su perfil de vertical EXPLÍCITO (espejo del
// gate del release de arfagi: sin perfil, el backend ahora es GENERIC). La boutique (T2)
// queda SIN perfil a propósito: cubre el default generic real.
await db.doc(`tenants/${T}/config/catalog`).set({ profile: { vertical: 'perfumeria' } }, { merge: true });
await db.doc(`tenants/${T2}/config/catalog`).delete().catch(() => {});
await db.doc(`tenants/${T}/categories/perfumes`).set({ id: 'perfumes', tenantId: T, name: 'Perfumes', isActive: true, position: 0, createdAt: now, updatedAt: now }, { merge: true });
await db.doc(`tenants/${T2}/categories/general`).set({ id: 'general', tenantId: T2, name: 'General', isActive: true, position: 0, createdAt: now, updatedAt: now }, { merge: true });

// Manager del tenant (los seeds no lo traen y CO-23 exige probar el rol REAL, no un proxy).
async function ensureManager() {
  let u;
  try { u = await adminAuth.getUserByEmail('manager@perfumeria.com'); }
  catch { u = await adminAuth.createUser({ email: 'manager@perfumeria.com', password: 'test1234', displayName: 'Gerente Perfumería' }); }
  await adminAuth.setCustomUserClaims(u.uid, { role: 'TENANT_MANAGER', tenantId: T });
  await db.doc(`users/${u.uid}`).set({ id: u.uid, email: 'manager@perfumeria.com', name: 'Gerente Perfumería', role: 'TENANT_MANAGER', tenantId: T, status: 'ACTIVE', updatedAt: now }, { merge: true });
}
await ensureManager();

const owner = await signIn('owner@perfumeria.com');
const seller = await signIn('seller@perfumeria.com');
const manager = await signIn('manager@perfumeria.com');
const admin = await signIn('superadmin@aiafg.com');
const ownerBoutique = await signIn('owner@boutique.com');

const runImport = (token, data = {}) => call('metaCatalogImportRun', token, data);

// ═══ CO-1. Catálogo vacío ⇒ run completed con contadores en 0 ═══
await setFixture([]);
{
  const { result: r } = await runImport(owner, {});
  check('CO-1. catálogo vacío ⇒ completed con TODOS los contadores en 0', r?.ok === true && r?.status === 'completed' && r?.more === false && countersEq(r?.counters, {}) && r?.processed === 0, countersStr(r?.counters));
  const run = await runDocOf(T, r?.runId);
  const st = await stateOf(T);
  check('CO-1b. run doc persistido (completed, con actor y catálogo) y puntero liberado', run?.status === 'completed' && run?.catalogId === CATALOG_ID && !!run?.actorUid && st?.activeRunId === null, `status=${run?.status}`);
  check('CO-1c. un run vacío NO fabrica una campana de calidad', (await notifOf(T)) === null);
}

// ═══ CO-2. Una página (con categoría destino) ═══
await setFixture([1, 2, 3].map((i) => item(`MINI-${i}`, { name: `Articulo Inicial ${i}`, description: `Articulo inicial ${i} linea corta`, brand: 'MarcaMini' })));
{
  const { result: r } = await runImport(owner, { defaultCategoryId: 'perfumes' });
  check('CO-2. una página ⇒ completed con 3 importados clasificados', r?.status === 'completed' && r?.pagesDone === 1 && countersEq(r?.counters, { imported: 3 }), countersStr(r?.counters));
  const p = await productOf(T, 'meta_MINI-1');
  check('CO-2b. el importado nace INACTIVE + syncToMeta=false + stock sin inventar (pendiente de revisión)', p?.status === 'INACTIVE' && p?.syncToMeta === false && p?.stockPendingReview === true && p?.inventory?.trackStock === false && p?.inventory?.stock === 0);
  check('CO-2c. identidad remota + categoría del run + marca NEUTRAL + precio parseado', p?.metaRetailerId === 'MINI-1' && p?.metaCatalogId === CATALOG_ID && p?.categoryId === 'perfumes' && p?.brand === 'MarcaMini' && p?.price === 150000 && p?.currency === 'PYG');
  check('CO-2c². el perfil perfumeria EXPLÍCITO del tenant arma la ficha perfume (compat arfagi)', p?.perfume?.brand === 'MarcaMini');
  check('CO-2d. la calidad nace CON el producto (blocking por not_active + stock_pending_review)', p?.quality?.blocking === 2 && obsActiva(p?.quality, 'not_active') && obsActiva(p?.quality, 'stock_pending_review'), `blocking=${p?.quality?.blocking}`);
  check('CO-2e. NO se inventa productFinancials (el costo queda desconocido)', !(await db.doc(`tenants/${T}/productFinancials/meta_MINI-1`).get()).exists);
  const lock = (await db.doc(`tenants/${T}/metaRetailerLocks/MINI-1`).get()).data();
  check('CO-2f. el lock del retailer_id se escribe EN LA MISMA importación (cierra el doble vínculo)', lock?.productId === 'meta_MINI-1' && lock?.retailerId === 'MINI-1');
}

// ═══ CO-3. Multi-página ═══
await setFixture([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => item(`MULTI-${i}`, { name: `Articulo Multiple ${i}`, description: `Articulo multiple ${i} linea corta`, brand: 'MarcaMulti' })), { pagesPerList: 3 });
{
  const { result: r } = await runImport(owner, { defaultCategoryId: 'perfumes' });
  check('CO-3. multi-página ⇒ 3 páginas en una invocación, 9 importados', r?.status === 'completed' && r?.pagesDone === 3 && countersEq(r?.counters, { imported: 9 }), `pages=${r?.pagesDone} ${countersStr(r?.counters)}`);
  const docs = (await db.collection(`tenants/${T}/products`).get()).docs.filter((d) => d.id.startsWith('meta_MULTI-'));
  check('CO-3b. las tres páginas quedaron completas en Firestore', docs.length === 9, `docs=${docs.length}`);
}
await wipeImportArtifacts(T);

// ═══ CO-4. >500 artículos (600 en ≥6 páginas) — contadores exactos, ninguno afuera ═══
const bigItem = (i) => item(`OB600-${String(i).padStart(3, '0')}`, {
  name: `Articulo Masivo ${i}`, description: `Articulo masivo ${i} de la linea de prueba`, brand: 'MarcaMasiva', price: '₲100.000',
});
const BIG600 = Array.from({ length: 600 }, (_, i) => bigItem(i + 1));
await setFixture(BIG600, { pagesPerList: 6 });
{
  const { result: r } = await runImport(owner, { maxPages: 10 });
  check('CO-4. 600 items en 6 páginas ⇒ completed con contadores EXACTOS', r?.status === 'completed' && r?.pagesDone === 6 && r?.processed === 600 && countersEq(r?.counters, { imported: 600, unclassified: 600 }), `pages=${r?.pagesDone} ${countersStr(r?.counters)}`);
  const ids = new Set((await db.collection(`tenants/${T}/products`).get()).docs.map((d) => d.id).filter((id) => id.startsWith('meta_OB600-')));
  const faltantes = BIG600.map((x) => `meta_${x.retailer_id}`).filter((id) => !ids.has(id));
  check('CO-4b. NINGÚN producto quedó fuera (600/600 presentes, sin huecos entre páginas)', ids.size === 600 && faltantes.length === 0, `docs=${ids.size} faltan=${faltantes.slice(0, 3).join(',')}`);
}
{
  const notifs = await db.collection(`tenants/${T}/notifications`).where('category', '==', 'catalog_quality').get();
  const n = await notifOf(T);
  check('CO-21. tras importar 600, hay UNA sola campana agregada (jamás una por producto)', notifs.size === 1 && n?.dedupeKey === `catalog-quality-${T}`, `notifs=${notifs.size}`);
  check('CO-21b. el agregado declara su tope con honestidad (500+ bloqueados, sin inventar exactitud)', n?.blockingCount === 500 && n?.warningCount === 500 && n?.resolvedAt === null && /o más/.test(String(n?.body ?? '')), `blocking=${n?.blockingCount}`);
}

// ═══ CO-5 + CO-18. Cursor inválido ⇒ reset contado, el run completa; re-escaneo sin dobles ═══
await wipeImportArtifacts(T);
const MED30 = Array.from({ length: 30 }, (_, i) => item(`OBMED-${String(i + 1).padStart(2, '0')}`, {
  name: `Articulo Mediano ${i + 1}`, description: `Articulo mediano ${i + 1} linea corta`, brand: 'MarcaMediana', price: '₲120.000',
}));
await setFixture(MED30, { pagesPerList: 6 });
{
  const { result: r1 } = await runImport(owner, { maxPages: 1 });
  check('CO-5(pre). primera invocación deja cursor persistido y 5 importados', r1?.status === 'running' && r1?.hasCursor === true && r1?.counters?.imported === 5, countersStr(r1?.counters));
  // El cursor persistido ('page:1') queda FUERA DE RANGO al cambiar la paginación del fixture:
  // el fake lo rechaza como invalid_cursor — el mismo 400 code 100 de un cursor de Graph vencido.
  await db.doc(FIXTURE).set({ pagesPerList: 1 }, { merge: true });
  const { result: r2 } = await runImport(owner, {});
  check('CO-5. cursor inválido ⇒ cursorResets>0 y el run COMPLETA igual (reinicia desde cero)', r2?.status === 'completed' && r2?.counters?.cursorResets === 1 && r2?.counters?.imported === 30, countersStr(r2?.counters));
  check('CO-5b. lo re-escaneado se declara alreadyImported (no se pierde ni se duplica)', r2?.counters?.alreadyImported === 5, `alreadyImported=${r2?.counters?.alreadyImported}`);
  const ids = (await db.collection(`tenants/${T}/products`).get()).docs.map((d) => d.id).filter((id) => id.startsWith('meta_OBMED-'));
  check('CO-18. los items procesados DOS veces en el mismo run quedaron con UN solo doc cada uno', ids.length === 30 && new Set(ids).size === 30, `docs=${ids.length}`);
}

// ═══ CO-6. Reanudación: maxPages:1 ⇒ running+more; reinvocar hasta completed ═══
await wipeImportArtifacts(T);
await setFixture(MED30, { pagesPerList: 6 });
{
  const { result: r1 } = await runImport(owner, { maxPages: 1 });
  check('CO-6. maxPages:1 ⇒ status running + more:true (el panel debe re-invocar)', r1?.status === 'running' && r1?.more === true && r1?.pagesDone === 1, `status=${r1?.status} pages=${r1?.pagesDone}`);
  const runDoc = await runDocOf(T, r1?.runId);
  check('CO-6b. el progreso queda PERSISTIDO entre llamadas (cursor + contadores en el run doc)', runDoc?.status === 'running' && runDoc?.cursor === 'page:1' && runDoc?.counters?.imported === 5 && runDoc?.leaseUntil === null, `cursor=${runDoc?.cursor}`);
  const { result: r2 } = await runImport(owner, { resume: true, maxPages: 1 });
  check('CO-6c. resume:true retoma el MISMO run desde el cursor (página 2, sin re-importar)', r2?.runId === r1?.runId && r2?.pagesDone === 2 && r2?.counters?.imported === 10 && r2?.counters?.alreadyImported === 0, countersStr(r2?.counters));
  let fin = r2;
  for (let i = 0; i < 8 && fin?.status !== 'completed'; i++) fin = (await runImport(owner, { maxPages: 1 })).result;
  check('CO-6d. reinvocando se llega a completed con el catálogo entero y CERO re-importes', fin?.status === 'completed' && fin?.pagesDone === 6 && countersEq(fin?.counters, { imported: 30, unclassified: 30 }), countersStr(fin?.counters));
  const { err } = await runImport(owner, { resume: true });
  check('CO-6e. resume:true sin run activo ⇒ failed-precondition (un "continuar" jamás arranca de cero)', err === 'FAILED_PRECONDITION', `err=${err}`);
}

// ═══ CO-7. Fallo parcial: el run guarda cursor y error saneado; reanudar completa ═══
await wipeImportArtifacts(T);
await setFixture(MED30, { pagesPerList: 6 });
{
  const { result: r1 } = await runImport(owner, { maxPages: 1 });
  await db.doc(FIXTURE).set({ failWith: { op: 'listItems', status: 500, code: 1, message: 'derrumbe transitorio del listado' } }, { merge: true });
  const { result: r2 } = await runImport(owner, {});
  check('CO-7. fallo remoto a mitad de run ⇒ queda running con stopReason y error SANEADO', r2?.status === 'running' && r2?.stopReason === 'remote_error' && String(r2?.lastError ?? '').includes('derrumbe transitorio') && !/bearer|token/i.test(String(r2?.lastError ?? '')), `stop=${r2?.stopReason}`);
  const runDoc = await runDocOf(T, r1?.runId);
  check('CO-7b. el cursor NO se perdió con el fallo (persistido para reanudar)', runDoc?.cursor === 'page:1' && String(runDoc?.lastError ?? '').includes('derrumbe transitorio'), `cursor=${runDoc?.cursor}`);
  await db.doc(FIXTURE).set({ failWith: null }, { merge: true });
  const { result: r3 } = await runImport(owner, {});
  check('CO-7c. al reanudar tras el fallo, completa desde el cursor SIN re-importar nada', r3?.status === 'completed' && countersEq(r3?.counters, { imported: 30, unclassified: 30 }), countersStr(r3?.counters));
}

// ═══ CO-8. Dos imports concurrentes ⇒ uno recibe already_running ═══
await wipeImportArtifacts(T);
await setFixture(BIG600, { pagesPerList: 6 });
let bigRunId = null;
{
  const [a, b] = await Promise.all([runImport(owner, { maxPages: 10 }), runImport(owner, { maxPages: 10 })]);
  const bloqueados = [a, b].filter((r) => r.result?.status === 'already_running');
  const ganador = [a, b].find((r) => r.result?.ok === true)?.result;
  bigRunId = ganador?.runId ?? null;
  check('CO-8. dos imports CONCURRENTES ⇒ exactamente uno recibe already_running', bloqueados.length === 1 && ganador?.status === 'completed' && ganador?.counters?.imported === 600, `bloqueados=${bloqueados.length} ganador=${ganador?.status}`);
  check('CO-8b. el rechazado recibe el estado ACTUAL del run activo (para mostrar progreso, no un error mudo)', bloqueados[0]?.result?.run?.runId === bigRunId && bloqueados[0]?.result?.run?.status === 'running', `runId=${bloqueados[0]?.result?.run?.runId?.slice(-6)}`);
}
{
  // Verificación DETERMINÍSTICA del lease: un run activo con lease vigente rechaza al segundo.
  const synthRef = db.doc(`tenants/${T}/metaCatalogImportRuns/synth-lease-1`);
  await synthRef.set({
    runId: 'synth-lease-1', tenantId: T, catalogId: CATALOG_ID, status: 'running', cursor: 'page:1',
    pagesDone: 1, processed: 100, counters: {}, blockedByReason: {}, defaultCategoryId: '',
    leaseUntil: Timestamp.fromMillis(Date.now() + 60_000), attempts: 1, actorUid: 'synthetic',
    lastError: '', startedAt: now, updatedAt: now, finishedAt: null,
  });
  await db.doc(`tenants/${T}/metaCatalogImportState/current`).set({ tenantId: T, activeRunId: 'synth-lease-1', lastRunId: 'synth-lease-1', updatedAt: now }, { merge: true });
  const { result: r } = await runImport(owner, {});
  check('CO-8c. lease vigente ⇒ already_running también sin carrera (contrato del claim)', r?.status === 'already_running' && r?.run?.runId === 'synth-lease-1', `status=${r?.status}`);
  await synthRef.delete();
  await db.doc(`tenants/${T}/metaCatalogImportState/current`).set({ tenantId: T, activeRunId: null, lastRunId: bigRunId, updatedAt: now }, { merge: true });
}

// ═══ CO-9. Reintento idempotente: re-importar TODO ⇒ 0 nuevos, cero duplicados ═══
{
  const antes = (await db.collection(`tenants/${T}/products`).get()).size;
  const { result: r } = await runImport(owner, { maxPages: 10 });
  const despues = (await db.collection(`tenants/${T}/products`).get()).size;
  check('CO-9. re-importar todo el catálogo ⇒ 0 nuevos y TODOS alreadyImported', r?.status === 'completed' && countersEq(r?.counters, { alreadyImported: 600 }), countersStr(r?.counters));
  check('CO-9b. cero duplicados: el conteo de products quedó idéntico', antes === despues && (await db.collection(`tenants/${T}/products`).get()).docs.filter((d) => d.id.startsWith('meta_OB600-')).length === 600, `antes=${antes} después=${despues}`);
}
await wipeImportArtifacts(T);

// ═══ Fase curada: clasificación fina + calidad + recorrido completo (T) ═══
const localBase = (id, over = {}) => ({
  id, tenantId: T, name: `Producto ${id}`, description: `Producto ${id} descripcion`, price: 100000,
  compareAtPrice: null, aiNotes: '', currency: 'PYG', categoryId: 'perfumes', images: [IMG(id)], emoji: '',
  inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: id }, status: 'ACTIVE', featured: false,
  position: 500, externalIds: { facebook: null, instagram: null, tiktok: null }, brand: 'MarcaLocal',
  perfume: null, aiFicha: null, productUrl: `https://tienda.e2e.test/p/${id}`, syncToMeta: false,
  createdAt: now, updatedAt: now, ...over,
});
// Producto local YA VINCULADO al artículo ONB-LINKED (CO-17) y producto local MUY parecido
// al artículo ONB-AMBIG (CO-11: el run jamás auto-vincula ni importa un probable duplicado).
await db.doc(`tenants/${T}/products/ONB-LOCAL-LINKED`).set(localBase('ONB-LOCAL-LINKED', {
  name: 'Producto Local Vinculado', brand: 'BellaCasa', price: 120000,
  metaRetailerId: 'ONB-LINKED', metaCatalogId: CATALOG_ID, metaProductItemId: 'itm-ONB-LINKED', metaSyncStatus: 'not_synced',
}));
await db.doc(`tenants/${T}/products/ONB-LOCAL-SIMILAR`).set(localBase('ONB-LOCAL-SIMILAR', {
  name: 'Colonia Mistica Dorada', brand: 'CasaAroma', price: 180000,
}));

const CURATED = [
  item('ONB-OK', { name: 'Crema Hidratante Rosa Silvestre', description: 'Crema hidratante rosa silvestre para todo tipo de piel', brand: 'BellaCasa', price: '₲150.000' }),
  item('ONB-LINKED', { name: 'Aceite Corporal Almendras', description: 'Aceite corporal de almendras puro prensado en frio', brand: 'BellaCasa', price: '₲120.000' }),
  item('ONB-AMBIG', { name: 'Colonia Mistica Dorada', description: 'Colonia mistica dorada edicion de coleccion', brand: 'CasaAroma', price: '₲180.000' }),
  item('ONB-DUP-1', { name: 'Esencia Real Nocturna', description: 'Esencia real nocturna con notas ambaradas', brand: 'CasaAroma', price: '₲200.000' }),
  item('ONB-DUP-2', { name: 'Esencia Real Nocturna', description: 'Esencia real nocturna presentacion grande', brand: 'CasaAroma', price: '₲220.000' }),
  item('ONB-GEN', { name: 'CasaLinda', description: 'Productos de belleza CasaLinda para el hogar', brand: 'CasaLinda', price: '₲90.000' }),
  item('ONB-BADCUR', { name: 'Serum Vitamina Andina', description: 'Serum vitamina andina concentrado', price: '15.00', currency: 'USD' }),
  item('ONB-BADPRICE', { name: 'Jabon Artesanal Lavanda', description: 'Jabon artesanal de lavanda organica', price: 'precio a confirmar' }),
  item('ONB-BADIMG', { name: 'Balsamo Labial Cereza', description: 'Balsamo labial de cereza intensa', price: '₲60.000', image_url: 'http://inseguro.e2e.test/balsamo.jpg' }),
];
await setFixture(CURATED, { pagesPerList: 3 });

let curatedRunId = null;
{
  const { result: r } = await runImport(owner, {}); // SIN categoría: los importables entran como borrador
  curatedRunId = r?.runId ?? null;

  // CO-11. Mapping ambiguo: candidato FUERTE de un producto local sin vínculo ⇒ requiere humano.
  check('CO-11. artículo casi idéntico a un local sin vínculo ⇒ ambiguous y NO se importa', r?.counters?.ambiguous === 1 && r?.blockedByReason?.strong_mapping_candidate === 1 && (await productOf(T, 'meta_ONB-AMBIG')) === null, countersStr(r?.counters));

  // CO-12. Duplicados remotos ⇒ importados con observación probable_duplicate (WARNING).
  const dup1 = await productOf(T, 'meta_ONB-DUP-1');
  const dup2 = await productOf(T, 'meta_ONB-DUP-2');
  check('CO-12. los duplicados remotos SE IMPORTAN igual (la calidad avisa, no censura)', !!dup1 && !!dup2 && r?.counters?.imported === 4, `imported=${r?.counters?.imported}`);
  const oDup = obsOf(dup2?.quality, 'probable_duplicate');
  check('CO-12b. el segundo homónimo lleva probable_duplicate como WARNING activo', obsActiva(dup2?.quality, 'probable_duplicate') && oDup?.severity === 'WARNING' && !obsActiva(dup1?.quality, 'probable_duplicate'), `obs=${JSON.stringify(oDup ?? {}).slice(0, 80)}`);

  // CO-13. Categoría desconocida ⇒ borrador sin clasificar con la doble marca (WARNING + BLOCKING de sync).
  const okDoc = await productOf(T, 'meta_ONB-OK');
  check('CO-13. sin categoría ⇒ importado IGUAL como borrador (categoryId vacío, INACTIVE)', okDoc?.categoryId === '' && okDoc?.status === 'INACTIVE' && r?.counters?.unclassified === 4, `unclassified=${r?.counters?.unclassified}`);
  check('CO-13b. la doble marca: category_unclassified (WARNING) + category_missing (BLOCKING de sync)', obsActiva(okDoc?.quality, 'category_unclassified') && obsOf(okDoc?.quality, 'category_unclassified')?.severity === 'WARNING' && obsActiva(okDoc?.quality, 'category_missing') && obsOf(okDoc?.quality, 'category_missing')?.severity === 'BLOCKING');
  check('CO-13c. el borrador es VISIBLE para el panel (read del cliente permitido)', (await restGet(`tenants/${T}/products/meta_ONB-OK`, owner)) === 200);

  // CO-14. Nombre genérico ⇒ WARNING generic_name.
  const gen = await productOf(T, 'meta_ONB-GEN');
  check('CO-14. nombre ≈ marca ⇒ WARNING generic_name (importado igual)', !!gen && obsActiva(gen?.quality, 'generic_name') && obsOf(gen?.quality, 'generic_name')?.severity === 'WARNING');

  // CO-15 / CO-16. Bloqueos duros del análisis remoto ⇒ skipped con razón, jamás importados.
  check('CO-15. precio no interpretable o moneda ajena ⇒ skipped con razón invalid_price', r?.blockedByReason?.invalid_price === 2 && (await productOf(T, 'meta_ONB-BADCUR')) === null && (await productOf(T, 'meta_ONB-BADPRICE')) === null, `invalid_price=${r?.blockedByReason?.invalid_price}`);
  check('CO-16. imagen no-https ⇒ skipped con razón image_not_https', r?.blockedByReason?.image_not_https === 1 && (await productOf(T, 'meta_ONB-BADIMG')) === null);

  // CO-17. Ya vinculado ⇒ alreadyLinked, sin duplicar la identidad remota.
  const conRid = await db.collection(`tenants/${T}/products`).where('metaRetailerId', '==', 'ONB-LINKED').get();
  check('CO-17. artículo ya vinculado a un local ⇒ alreadyLinked y NO se duplica', r?.counters?.alreadyLinked === 1 && (await productOf(T, 'meta_ONB-LINKED')) === null && conRid.size === 1, `docs con rid=${conRid.size}`);
  check('CO-17b. contadores del run curado exactos (3 páginas)', r?.status === 'completed' && r?.pagesDone === 3 && countersEq(r?.counters, { imported: 4, alreadyLinked: 1, ambiguous: 1, skipped: 3, unclassified: 4 }), countersStr(r?.counters));
}

// ═══ CO-21c. Campana agregada del tenant: contadores correctos tras el run ═══
{
  const notifs = await db.collection(`tenants/${T}/notifications`).where('category', '==', 'catalog_quality').get();
  const n = await notifOf(T);
  const conBloqueo = (await db.collection(`tenants/${T}/products`).where('quality.blocking', '>', 0).get()).size;
  check('CO-21c. la campana sigue siendo UNA sola y sus contadores espejan el agregado real', notifs.size === 1 && n?.blockingCount === conBloqueo && conBloqueo === 4 && n?.warningCount === 4 && n?.resolvedAt === null, `blocking=${n?.blockingCount} real=${conBloqueo}`);
}

// ═══ CO-19 + CO-27a. BLOCKING no habilita sync; el resumen muestra los problemas ═══
{
  const { result: r } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'meta_ONB-OK', enabled: true });
  check('CO-19. un producto con BLOCKING no puede habilitar syncToMeta (gate lista los bloqueos)', r?.ok === false && ['not_active', 'category_missing', 'stock_pending_review'].every((b) => (r?.blockers ?? []).includes(b)), JSON.stringify(r?.blockers ?? []));
  const { result: sum } = await call('metaCatalogQualitySummary', manager, {});
  check('CO-27a. RECORRIDO: el centro de calidad muestra los problemas tras importar', sum?.ok === true && sum?.conBloqueos === 4 && sum?.porCodigo?.category_missing?.count === 4 && sum?.porCodigo?.not_active?.count === 4 && sum?.muestras?.some((m) => m.productId === 'meta_ONB-OK'), `conBloqueos=${sum?.conBloqueos}`);
}

// ═══ CO-20. Corregir vía productUpsert resuelve y sella; AHORA setSyncEnabled funciona ═══
{
  const { result: up } = await call('productUpsert', owner, {
    id: 'meta_ONB-OK',
    data: { status: 'ACTIVE', categoryId: 'perfumes', inventory: { trackStock: true, stock: 8, lowStockThreshold: 1, sku: 'ONB-OK' } },
  });
  const codes = (up?.quality?.resueltas ?? []).map((o) => o.code);
  check('CO-20. el guardado informa QUÉ resolvió (respuesta {quality.resueltas})', up?.ok === true && ['not_active', 'category_missing', 'stock_pending_review', 'category_unclassified'].every((c) => codes.includes(c)) && (up?.quality?.pendientes ?? []).length === 0, JSON.stringify(codes));
  const p = await productOf(T, 'meta_ONB-OK');
  const sellada = obsOf(p?.quality, 'not_active');
  check('CO-20b. la observación resuelta queda SELLADA en el doc (resolvedAt, histórico no borrado)', p?.quality?.blocking === 0 && !!sellada && sellada.resolvedAt !== null, `blocking=${p?.quality?.blocking}`);
  const { result: sinConfirmar } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'meta_ONB-OK', enabled: true });
  check('CO-20c. ya sin bloqueos, habilitar exige confirmar el diff (intent update: el artículo existe en Meta)', sinConfirmar?.ok === false && sinConfirmar?.requiresConfirmation === true && sinConfirmar?.intent === 'update', `intent=${sinConfirmar?.intent}`);
  const { result: confirmado } = await call('metaCatalogSetSyncEnabled', owner, { productId: 'meta_ONB-OK', enabled: true, confirmDiff: true });
  const p2 = await productOf(T, 'meta_ONB-OK');
  check('CO-20d. con confirmDiff:true AHORA sí se habilita (syncToMeta=true persistido)', confirmado?.ok === true && confirmado?.enabled === true && p2?.syncToMeta === true);
}

// ═══ CO-27b. RECORRIDO: el resumen refleja la corrección; nada tocó Meta ═══
{
  const { result: sum } = await call('metaCatalogQualitySummary', owner, {});
  check('CO-27b. tras corregir, el resumen baja (el producto sano sale del centro de calidad)', sum?.ok === true && sum?.conBloqueos === 3 && !sum?.muestras?.some((m) => m.productId === 'meta_ONB-OK'), `conBloqueos=${sum?.conBloqueos}`);
}

// ═══ CO-25. Importado invisible para bot/carrito; vendibilidad trackStock-aware ═══
const { searchCatalog, getProductById } = await import(new URL('../lib/catalog/search.js', import.meta.url).href);
{
  const vistos = (await searchCatalog(T, { limit: 1000 })).map((p) => p.id);
  check('CO-25. el importado INACTIVE es INVISIBLE para el bot; el corregido y activado SÍ aparece', !vistos.includes('meta_ONB-GEN') && !vistos.includes('meta_ONB-DUP-1') && !vistos.includes('meta_ONB-DUP-2') && vistos.includes('meta_ONB-OK'), `vistos=${vistos.length}`);
  check('CO-25b. tampoco entra al carrito por id (getProductById gatea por status)', (await getProductById(T, 'meta_ONB-GEN')) === null && (await getProductById(T, 'meta_ONB-OK'))?.id === 'meta_ONB-OK');
}

// ═══ CO-10. Dos tenants con retailerIds IGUALES, aislados ═══
let t2RunId = null;
{
  const okAntesT = await productOf(T, 'meta_ONB-OK');
  const { result: r } = await runImport(ownerBoutique, {});
  t2RunId = r?.runId ?? null;
  check('CO-10. el MISMO fixture importado en el segundo tenant ⇒ clasificación propia (sin locales, importa 6)', r?.status === 'completed' && countersEq(r?.counters, { imported: 6, skipped: 3, unclassified: 6 }), countersStr(r?.counters));
  const okT2 = await productOf(T2, 'meta_ONB-OK');
  const linkedT2 = await productOf(T2, 'meta_ONB-LINKED');
  check('CO-10b. cada tenant tiene SUS docs bajo su propia ruta (mismo retailer_id, dos productos)', okT2?.tenantId === T2 && linkedT2?.tenantId === T2 && (await productOf(T2, 'meta_ONB-AMBIG'))?.tenantId === T2);
  check('CO-10b². la boutique SIN perfil importa GENERIC: sin ficha perfume, marca solo en brand (HARDEN-1)', okT2?.perfume === null && okT2?.brand === 'BellaCasa');
  const okDespuesT = await productOf(T, 'meta_ONB-OK');
  check('CO-10c. el import de T2 NO tocó al tenant original (ni docs nuevos ni ediciones)', (await productOf(T, 'meta_ONB-LINKED')) === null && (await productOf(T, 'meta_ONB-AMBIG')) === null && okDespuesT?.updatedAt?.toMillis?.() === okAntesT?.updatedAt?.toMillis?.() && okDespuesT?.tenantId === T);
  const lockT = (await db.doc(`tenants/${T}/metaRetailerLocks/ONB-OK`).get()).data();
  const lockT2 = (await db.doc(`tenants/${T2}/metaRetailerLocks/ONB-OK`).get()).data();
  check('CO-10d. los locks del retailer_id viven POR tenant (sin cruces)', lockT?.tenantId === T && lockT?.productId === 'meta_ONB-OK' && lockT2?.tenantId === T2 && lockT2?.productId === 'meta_ONB-OK');
}

// ═══ CO-24. Aislamiento cross-tenant por claims ═══
{
  const { result: st } = await call('metaCatalogImportStatus', ownerBoutique, { tenantId: T });
  check('CO-24. un OWNER ajeno pidiendo el tenant de otro recibe SU propio estado (claims mandan)', st?.ok === true && st?.run?.runId === t2RunId && st?.run?.runId !== curatedRunId, `run=${st?.run?.runId?.slice(-6)}`);
  const { result: sum } = await call('metaCatalogQualitySummary', ownerBoutique, { tenantId: T });
  check('CO-24b. el resumen de calidad tampoco cruza tenants (cuenta la boutique, no perfumería)', sum?.ok === true && sum?.conBloqueos === 6, `conBloqueos=${sum?.conBloqueos}`);
  const { err: e1 } = await call('metaCatalogImportStatus', seller, { tenantId: T2 });
  check('CO-24c. un SELLER no alcanza NINGÚN tenant (ni el propio ni ajeno)', e1 === 'PERMISSION_DENIED', `err=${e1}`);
  const { err: e2 } = await call('metaCatalogImportRun', admin, {});
  check('CO-24d. PLATFORM_ADMIN sin tenant explícito ⇒ invalid-argument (jamás un default)', e2 === 'INVALID_ARGUMENT', `err=${e2}`);
}

// ═══ CO-23. Roles: seller NO corre; manager lee; owner todo ═══
{
  const { err: eSeller } = await runImport(seller, {});
  check('CO-23. SELLER no puede correr metaCatalogImportRun', eSeller === 'PERMISSION_DENIED', `err=${eSeller}`);
  const { err: eManager } = await runImport(manager, {});
  check('CO-23b. MANAGER tampoco corre el import (es una acción de dueño)', eManager === 'PERMISSION_DENIED', `err=${eManager}`);
  const { result: sum } = await call('metaCatalogQualitySummary', manager, {});
  const { result: st } = await call('metaCatalogImportStatus', manager, {});
  check('CO-23c. MANAGER sí lee el resumen de calidad y el estado del import', sum?.ok === true && st?.ok === true && st?.run?.runId === curatedRunId, `run=${st?.run?.runId?.slice(-6)}`);
  const { err: eSellerSum } = await call('metaCatalogQualitySummary', seller, {});
  check('CO-23d. SELLER no lee ni el resumen', eSellerSum === 'PERMISSION_DENIED', `err=${eSellerSum}`);
  const { result: stAdmin } = await call('metaCatalogImportStatus', admin, { tenantId: T });
  check('CO-23e. OWNER opera todo y PLATFORM_ADMIN con tenant explícito también lee', stAdmin?.ok === true && stAdmin?.run?.runId === curatedRunId);
  const nManager = await restGet(`tenants/${T}/notifications/catalog-quality-${T}`, manager);
  const nSeller = await restGet(`tenants/${T}/notifications/catalog-quality-${T}`, seller);
  check('CO-23f. la campana de calidad la lee el MANAGER; el SELLER no (rules)', nManager === 200 && nSeller === 403, `manager=${nManager} seller=${nSeller}`);
}

// ═══ CO-22. Autocierre de la campana: resolver TODOS los bloqueos del tenant chico ═══
{
  const antes = await notifOf(T2);
  check('CO-22(pre). tras importar, la boutique tiene su campana abierta con 6 bloqueados', antes?.blockingCount === 6 && antes?.read === false && antes?.resolvedAt === null, `blocking=${antes?.blockingCount}`);
  const inv = (sku) => ({ trackStock: true, stock: 5, lowStockThreshold: 1, sku });
  // El orden importa: renombrar DUP-2 ANTES de tocar DUP-1 (si no, el recompute de DUP-1
  // vería el homónimo todavía vivo y reabriría probable_duplicate).
  const fixes = [
    { id: 'meta_ONB-OK', data: { status: 'ACTIVE', categoryId: 'general', inventory: inv('ONB-OK') } },
    { id: 'meta_ONB-LINKED', data: { status: 'ACTIVE', categoryId: 'general', inventory: inv('ONB-LINKED') } },
    { id: 'meta_ONB-AMBIG', data: { status: 'ACTIVE', categoryId: 'general', inventory: inv('ONB-AMBIG') } },
    { id: 'meta_ONB-DUP-2', data: { status: 'ACTIVE', categoryId: 'general', inventory: inv('ONB-DUP-2'), name: 'Esencia Real Nocturna Grande' } },
    { id: 'meta_ONB-DUP-1', data: { status: 'ACTIVE', categoryId: 'general', inventory: inv('ONB-DUP-1') } },
    { id: 'meta_ONB-GEN', data: { status: 'ACTIVE', categoryId: 'general', inventory: inv('ONB-GEN'), name: 'CasaLinda Splendor Floral' } },
  ];
  let todosOk = true;
  for (const f of fixes) {
    const { result } = await call('productUpsert', ownerBoutique, f);
    todosOk = todosOk && result?.ok === true;
  }
  const quedan = (await db.collection(`tenants/${T2}/products`).where('quality.blocking', '>', 0).get()).size;
  check('CO-22. corregir TODOS los productos deja el agregado en cero', todosOk && quedan === 0, `quedan=${quedan}`);
  const despues = await notifOf(T2);
  check('CO-22b. la campana se AUTOCIERRA (resuelta y leída, nunca borrada: el historial vale)', despues?.resolvedAt !== null && despues?.read === true && despues?.blockingCount === 0 && despues?.warningCount === 0 && /sin pendientes/i.test(String(despues?.title ?? '')), `title=${despues?.title}`);
}

// ═══ CO-25c/d. Fix de vendibilidad (trackStock-aware) con productos controlados ═══
{
  const t2Base = (id, over = {}) => ({ ...localBase(id, over), tenantId: T2, categoryId: 'general' });
  await db.doc(`tenants/${T2}/products/ptest-notrack`).set(t2Base('ptest-notrack', {
    name: 'Servicio Sin Control De Stock', inventory: { trackStock: false, stock: 0, lowStockThreshold: 0, sku: 'ptest-notrack' },
  }));
  await db.doc(`tenants/${T2}/products/ptest-track0`).set(t2Base('ptest-track0', {
    name: 'Producto Trackeado Agotado', inventory: { trackStock: true, stock: 0, lowStockThreshold: 1, sku: 'ptest-track0' },
  }));
  const vistos = (await searchCatalog(T2, { limit: 1000 })).map((p) => p.id);
  check('CO-25c. ACTIVE con trackStock:false y stock 0 SÍ aparece (rubros sin control de stock)', vistos.includes('ptest-notrack'), `vistos=${vistos.join(',').slice(0, 120)}`);
  check('CO-25d. ACTIVE con trackStock:true y stock 0 NO aparece (agotado de verdad)', !vistos.includes('ptest-track0'));
}

// ═══ CO-26. Rules: el cliente NO toca el estado del import ni falsifica la calidad ═══
{
  check('CO-26. el cliente NO lee metaCatalogImportRuns (ni el owner)', (await restGet(`tenants/${T}/metaCatalogImportRuns/${curatedRunId}`, owner)) === 403);
  check('CO-26b. el cliente NO lee metaCatalogImportState', (await restGet(`tenants/${T}/metaCatalogImportState/current`, owner)) === 403 && (await restGet(`tenants/${T}/metaCatalogImportState/current`, seller)) === 403);
  check('CO-26c. el cliente NO escribe el run (pisar el cursor/lease desde el navegador: prohibido)', (await restPatch(`tenants/${T}/metaCatalogImportRuns/${curatedRunId}`, { status: { stringValue: 'completed' } }, owner)) === 403);
  check('CO-26d. el cliente NO puede falsificar product.quality con un write directo', (await restPatch(`tenants/${T}/products/meta_ONB-GEN`, { quality: { stringValue: 'hack' } }, owner)) === 403);
}

// ═══ CO-27c. Cierre del recorrido: CERO escrituras hacia Meta en todo el programa ═══
{
  check('CO-27c. RECORRIDO COMPLETO sin tocar Meta: cero batches escritos por el fake', (await writesSnap()).empty);
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ HD. HARDEN-1 — mantenimiento, conflictos, fencing y legacy con lock  ═══
// ═══════════════════════════════════════════════════════════════════════════
// El escenario del mantenimiento corre en la BOUTIQUE (T2): no tiene seed propio, así que
// tras el wipe queda 100% controlada por este script y los contadores son EXACTOS.
const runMaint = (token, data = {}) => call('metaCatalogMaintenanceRun', token, data);
const MAINT_KEYS = ['examinados', 'locksCreados', 'locksExistentes', 'conflictos', 'qualityCalculada', 'qualityVigente'];
const maintStr = (c) => MAINT_KEYS.map((k) => `${k}=${c?.[k] ?? 0}`).join(' ');
const maintEq = (c, exp) => MAINT_KEYS.every((k) => (c?.[k] ?? 0) === (exp[k] ?? 0));
const maintRunOf = async (tenant, runId) => (await db.doc(`tenants/${tenant}/metaCatalogMaintenanceRuns/${runId}`).get()).data() ?? null;
/** Huella de escrituras del tenant: updateTime por producto + locks + campana. */
const t2Snapshot = async () => {
  const prods = await db.collection(`tenants/${T2}/products`).get();
  const locks = await db.collection(`tenants/${T2}/metaRetailerLocks`).get();
  const bell = await db.doc(`tenants/${T2}/notifications/catalog-quality-${T2}`).get();
  return {
    prodTimes: new Map(prods.docs.map((d) => [d.id, d.updateTime.toMillis()])),
    lockIds: locks.docs.map((d) => d.id).sort().join(),
    bellTime: bell.exists ? bell.updateTime.toMillis() : null,
  };
};

// ── Setup HD: boutique en cero + 206 productos controlados (simulan un catálogo legacy) ──
await wipeImportArtifacts(T2);
// La boutique no tiene seed propio: se vacía ENTERA. Residuos de otros harnesses (p.ej.
// MCE2E-X, que verify-meta-catalog deja en T2 y recrea en su propio setup) romperían los
// contadores EXACTOS del mantenimiento.
await deleteRefs((await db.collection(`tenants/${T2}/products`).get()).docs.map((d) => d.ref));
const t2hd = (id, over = {}) => ({
  id, tenantId: T2, name: `Producto ${id}`, description: `Producto ${id} descripcion corta`, price: 100000,
  compareAtPrice: null, aiNotes: '', currency: 'PYG', categoryId: 'general', images: [IMG(id)], emoji: '',
  inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: id }, status: 'ACTIVE', featured: false,
  position: 700, externalIds: { facebook: null, instagram: null, tiktok: null }, brand: 'MarcaHD',
  perfume: null, aiFicha: null, productUrl: `https://tienda.e2e.test/p/${id}`, syncToMeta: false,
  createdAt: now, updatedAt: now, ...over,
});
// Quality VIGENTE sintética (con contenido distintivo): el mantenimiento JAMÁS debe recalcularla.
const VIG_Q = {
  blocking: 1, warning: 0,
  fingerprints: { 'e2e_probe:name': { code: 'e2e_probe', severity: 'BLOCKING', field: 'name', message: 'observacion sintetica del harness', action: 'no tocar', firstSeenAt: now, lastSeenAt: now, resolvedAt: null, origin: 'system' } },
  evaluatedAt: now,
};
{
  const b = db.batch();
  // Legacy: identidad remota SIN lock (el hueco que el mantenimiento debe cerrar) y sin quality.
  b.set(db.doc(`tenants/${T2}/products/hdm-legacy-nolock`), t2hd('hdm-legacy-nolock', { metaRetailerId: 'HDRID-NOLOCK', metaCatalogId: CATALOG_ID }));
  // Identidad remota CON lock vigente + quality vigente (nada que hacer).
  b.set(db.doc(`tenants/${T2}/products/hdm-lockok`), t2hd('hdm-lockok', { metaRetailerId: 'HDRID-OK', metaCatalogId: CATALOG_ID, quality: { ...VIG_Q, blocking: 0, fingerprints: {} } }));
  b.set(db.doc(`tenants/${T2}/metaRetailerLocks/HDRID-OK`), { retailerId: 'HDRID-OK', productId: 'hdm-lockok', tenantId: T2, createdAt: now });
  // Sin identidad: uno con quality vigente (no se toca) y uno sin quality (INACTIVE ⇒ backfill con bloqueo).
  b.set(db.doc(`tenants/${T2}/products/hdm-conquality`), t2hd('hdm-conquality', { quality: VIG_Q }));
  b.set(db.doc(`tenants/${T2}/products/hdm-noquality`), t2hd('hdm-noquality', { status: 'INACTIVE' }));
  // CONFLICTO: dos productos del MISMO tenant reclamando el MISMO retailer_id.
  b.set(db.doc(`tenants/${T2}/products/hdm-confl-a`), t2hd('hdm-confl-a', { metaRetailerId: 'HDRID-DUP' }));
  b.set(db.doc(`tenants/${T2}/products/hdm-confl-b`), t2hd('hdm-confl-b', { metaRetailerId: 'HDRID-DUP' }));
  // 200 masivos sin quality: fuerzan DOS páginas (pageSize 200) y la reanudación real.
  for (let i = 1; i <= 200; i++) {
    const id = `hdm-bulk-${String(i).padStart(3, '0')}`;
    b.set(db.doc(`tenants/${T2}/products/${id}`), t2hd(id));
  }
  await b.commit();
}

// ═══ HD-1 + HD-3(preview). Mantenimiento preview: contadores exactos y CERO escrituras ═══
const baseHD = await t2Snapshot();
check('HD(setup). boutique 100% controlada: 206 productos, 1 lock, campana previa presente', baseHD.prodTimes.size === 206 && baseHD.lockIds === 'HDRID-OK' && baseHD.bellTime !== null, `prods=${baseHD.prodTimes.size}`);
{
  const { result: r } = await runMaint(ownerBoutique, {}); // sin mode: preview es el DEFAULT
  check('HD-1. mantenimiento SIN mode ⇒ preview por default, completed (2 páginas)', r?.ok === true && r?.mode === 'preview' && r?.status === 'completed' && r?.pagesDone === 2 && r?.more === false, `mode=${r?.mode} pages=${r?.pagesDone}`);
  check('HD-1b. contadores del preview EXACTOS: lock faltante y quality faltantes CONTADOS (no escritos)', maintEq(r?.counters, { examinados: 206, locksCreados: 1, locksExistentes: 1, conflictos: 1, qualityCalculada: 202, qualityVigente: 2 }), maintStr(r?.counters));
  const despues = await t2Snapshot();
  const intactos = [...baseHD.prodTimes].every(([id, t]) => despues.prodTimes.get(id) === t);
  check('HD-1c. preview = CERO escrituras: 206 docs byte-idénticos, ni un lock nuevo ni la campana', intactos && despues.prodTimes.size === 206 && despues.lockIds === baseHD.lockIds && despues.bellTime === baseHD.bellTime);
  const runDoc = await maintRunOf(T2, r?.runId);
  check('HD-1d. la corrida queda AUDITADA en su run doc (mode preview, completed, tenant-scoped)', runDoc?.mode === 'preview' && runDoc?.status === 'completed' && runDoc?.tenantId === T2);
  const confl = (r?.conflicts ?? []).find((c) => c.retailerId === 'HDRID-DUP');
  check('HD-3. dos productos reclamando el MISMO retailer_id ⇒ conflicto reportado con AMBOS productIds', (r?.conflicts ?? []).length === 1 && confl?.productIds?.join() === 'hdm-confl-a,hdm-confl-b' && r?.conflictsTruncated === false, JSON.stringify(r?.conflicts ?? []));
}

// ═══ HD-4. Apply sin confirm ⇒ rechazado (y mode desconocido, fail-closed) ═══
{
  const { err } = await runMaint(ownerBoutique, { mode: 'apply' });
  check('HD-4. apply SIN confirm:true ⇒ failed-precondition (la confirmación jamás es implícita)', err === 'FAILED_PRECONDITION', `err=${err}`);
  const { err: eModo } = await runMaint(ownerBoutique, { mode: 'yolo' });
  check('HD-4b. mode desconocido ⇒ invalid-argument', eModo === 'INVALID_ARGUMENT', `err=${eModo}`);
}

// ═══ HD-2 + HD-3(apply). Apply confirmado: backfill quirúrgico, conflicto sin ganador ═══
let applyConflicts = null;
{
  const preApply = await t2Snapshot();
  const vigAntes = JSON.stringify((await productOf(T2, 'hdm-conquality'))?.quality ?? null);
  const nolockAntes = await productOf(T2, 'hdm-legacy-nolock');
  const { result: r } = await runMaint(ownerBoutique, { mode: 'apply', confirm: true });
  applyConflicts = r?.conflicts ?? null;
  check('HD-2. apply con confirm:true ⇒ completed con LOS MISMOS contadores que anticipó el preview', r?.mode === 'apply' && r?.status === 'completed' && maintEq(r?.counters, { examinados: 206, locksCreados: 1, locksExistentes: 1, conflictos: 1, qualityCalculada: 202, qualityVigente: 2 }), maintStr(r?.counters));
  const lockNuevo = (await db.doc(`tenants/${T2}/metaRetailerLocks/HDRID-NOLOCK`).get()).data();
  check('HD-2b. el lock faltante del legacy AHORA existe (cierra el doble vínculo histórico)', lockNuevo?.productId === 'hdm-legacy-nolock' && lockNuevo?.retailerId === 'HDRID-NOLOCK' && lockNuevo?.tenantId === T2);
  const noq = await productOf(T2, 'hdm-noquality');
  check('HD-2c. el producto SIN quality la recibe (INACTIVE ⇒ not_active BLOCKING activo)', (noq?.quality?.blocking ?? 0) > 0 && obsActiva(noq?.quality, 'not_active'), `blocking=${noq?.quality?.blocking}`);
  const nolockDespues = await productOf(T2, 'hdm-legacy-nolock');
  const comerciales = (p) => JSON.stringify([p?.name, p?.price, p?.inventory, p?.status, p?.updatedAt?.toMillis?.() ?? null]);
  check('HD-2d. campos comerciales INTACTOS byte a byte (nombre/precio/stock/status; updatedAt sin tocar)', comerciales(nolockAntes) === comerciales(nolockDespues) && !!nolockDespues?.quality && !nolockAntes?.quality);
  const vigDespues = JSON.stringify((await productOf(T2, 'hdm-conquality'))?.quality ?? null);
  const vigTime = (await db.doc(`tenants/${T2}/products/hdm-conquality`).get()).updateTime.toMillis();
  const lockokTime = (await db.doc(`tenants/${T2}/products/hdm-lockok`).get()).updateTime.toMillis();
  check('HD-2e. la quality VIGENTE no cambió NI UN BYTE (mapa idéntico; docs ni re-escritos)', vigDespues === vigAntes && vigTime === preApply.prodTimes.get('hdm-conquality') && lockokTime === preApply.prodTimes.get('hdm-lockok'));
  const conflApply = (applyConflicts ?? []).find((c) => c.retailerId === 'HDRID-DUP');
  const conflA = await productOf(T2, 'hdm-confl-a');
  const conflB = await productOf(T2, 'hdm-confl-b');
  check('HD-3b. el apply REPORTA el conflicto y NO elige ganador: cero lock, cero quality en los ambiguos', conflApply?.productIds?.join() === 'hdm-confl-a,hdm-confl-b' && !(await db.doc(`tenants/${T2}/metaRetailerLocks/HDRID-DUP`).get()).exists && conflA?.quality === undefined && conflB?.quality === undefined);
  const conBloqueo = (await db.collection(`tenants/${T2}/products`).where('quality.blocking', '>', 0).get()).size;
  const bell = await notifOf(T2);
  check('HD-2f. la campana agregada se RECALCULA al terminar el apply (reabierta, espeja el conteo real)', bell?.blockingCount === conBloqueo && conBloqueo >= 2 && bell?.resolvedAt === null && bell?.read === false, `bell=${bell?.blockingCount} real=${conBloqueo}`);
}

// ═══ HD-5. Reanudación del mantenimiento + re-ejecución completa idempotente ═══
{
  const { result: r1 } = await runMaint(ownerBoutique, { mode: 'apply', confirm: true, maxPages: 1 });
  check('HD-5. maxPages:1 ⇒ queda running con cursor (un catálogo parcial JAMÁS se declara completo)', r1?.status === 'running' && r1?.more === true && r1?.hasCursor === true && r1?.stopReason === 'pages_budget' && r1?.pagesDone === 1, `status=${r1?.status}`);
  const runDoc = await maintRunOf(T2, r1?.runId);
  check('HD-5b. el run doc persiste cursor + modo entre invocaciones', runDoc?.status === 'running' && typeof runDoc?.cursor === 'string' && runDoc?.cursor.length > 0 && runDoc?.mode === 'apply', `cursor=${runDoc?.cursor}`);
  const { result: r2 } = await runMaint(ownerBoutique, { mode: 'apply', confirm: true, runId: r1?.runId });
  check('HD-5c. reinvocar con runId retoma DESDE el cursor y completa el MISMO run', r2?.runId === r1?.runId && r2?.status === 'completed' && r2?.pagesDone === 2, `pages=${r2?.pagesDone}`);
  check('HD-5d. la re-ejecución completa es IDEMPOTENTE: 0 locks nuevos, 0 quality nuevas, MISMOS conflictos', maintEq(r2?.counters, { examinados: 206, locksCreados: 0, locksExistentes: 2, conflictos: 1, qualityCalculada: 0, qualityVigente: 204 }) && JSON.stringify(r2?.conflicts) === JSON.stringify(applyConflicts), maintStr(r2?.counters));
  const { err } = await runMaint(ownerBoutique, { mode: 'apply', confirm: true, runId: r1?.runId });
  check('HD-5e. reanudar una corrida YA terminada ⇒ failed-precondition (iniciá una nueva)', err === 'FAILED_PRECONDITION', `err=${err}`);
}

// ═══ HD-6. Roles del mantenimiento: correr = owner; leer estado = manager+ ═══
{
  const { err: eSeller } = await runMaint(seller, {});
  const { err: eManager } = await runMaint(manager, {});
  check('HD-6. SELLER y MANAGER no pueden CORRER el mantenimiento (acción de dueño)', eSeller === 'PERMISSION_DENIED' && eManager === 'PERMISSION_DENIED', `seller=${eSeller} manager=${eManager}`);
  const { result: rT } = await runMaint(owner, {}); // preview sobre perfumería: cero escrituras
  check('HD-6b. el OWNER sí corre el mantenimiento de SU tenant', rT?.ok === true && rT?.mode === 'preview', `status=${rT?.status}`);
  const { result: st } = await call('metaCatalogMaintenanceStatus', manager, { runId: rT?.runId });
  check('HD-6c. el MANAGER sí LEE el estado del mantenimiento (contrato manager+, espejo del import)', st?.ok === true && st?.run?.runId === rT?.runId && st?.run?.mode === 'preview', `run=${st?.run?.runId?.slice(-6)}`);
  const { err: eSellerSt } = await call('metaCatalogMaintenanceStatus', seller, { runId: rT?.runId });
  check('HD-6d. el SELLER tampoco lee el estado', eSellerSt === 'PERMISSION_DENIED', `err=${eSellerSt}`);
  const { err: eAdmin } = await runMaint(admin, {});
  check('HD-6e. PLATFORM_ADMIN sin tenant explícito ⇒ invalid-argument (jamás un default)', eAdmin === 'INVALID_ARGUMENT', `err=${eAdmin}`);
}

// ═══ HD-7 + HD-9. Import CLÁSICO con lock por ítem + perfiles por vertical ═══
{
  await setFixture([
    item('HD-LEG-1', { name: 'Articulo Legado Uno', description: 'Articulo legado uno linea corta', brand: 'MarcaLegado' }),
    item('HD-LEG-2', { name: 'Articulo Legado Dos', description: 'Articulo legado dos linea corta', brand: 'MarcaLegadoDos' }),
  ]);
  const { result: rT } = await call('metaCatalogImportItems', owner, { retailerIds: ['HD-LEG-1'], categoryId: 'perfumes' });
  const lockLeg = (await db.doc(`tenants/${T}/metaRetailerLocks/HD-LEG-1`).get()).data();
  check('HD-7. el import clásico AHORA escribe el lock del retailer_id JUNTO al producto', rT?.ok === true && rT?.imported?.[0]?.productId === 'meta_HD-LEG-1' && lockLeg?.productId === 'meta_HD-LEG-1' && lockLeg?.retailerId === 'HD-LEG-1', JSON.stringify(rT?.blocked ?? []));
  const impT = await productOf(T, 'meta_HD-LEG-1');
  check('HD-9. perfil perfumeria EXPLÍCITO ⇒ el import clásico arma la ficha perfume (compat arfagi)', impT?.perfume?.brand === 'MarcaLegado' && impT?.brand === 'MarcaLegado' && impT?.status === 'INACTIVE' && impT?.syncToMeta === false);
  const { result: rT2 } = await call('metaCatalogImportItems', ownerBoutique, { retailerIds: ['HD-LEG-2'], categoryId: 'general' });
  const impT2 = await productOf(T2, 'meta_HD-LEG-2');
  check('HD-9b. tenant SIN perfil ⇒ import clásico GENERIC: marca top-level y perfume null', rT2?.ok === true && impT2?.brand === 'MarcaLegadoDos' && impT2?.perfume === null, `brand=${impT2?.brand}`);
  // El rid del importado legacy ya tiene DUEÑO: confirmarlo sobre OTRO producto se rechaza.
  await db.doc(`tenants/${T}/products/hdm-map-victim`).set(localBase('hdm-map-victim', { name: 'Producto Victima Mapeo HD' }));
  const { err } = await call('metaCatalogConfirmMapping', owner, { productId: 'hdm-map-victim', retailerId: 'HD-LEG-1' });
  check('HD-7b. confirmMapping de un rid YA reclamado por el importado legacy ⇒ failed-precondition', err === 'FAILED_PRECONDITION', `err=${err}`);
}

// ═══ HD-8. Fencing generacional del run de importación (claim/generation E2E) ═══
// Suspender un worker REAL a mitad de invocación no es reproducible vía REST (esa carrera
// exacta la cubren los unit tests de fencing en memoria). Acá se verifica el contrato
// DURABLE: generación persistida en puntero+run, incrementada en cada takeover, y un worker
// zombi — el store REAL compilado portando la generación superada — que no escribe NADA.
{
  await deleteRefs((await db.collection(`tenants/${T2}/metaCatalogImportRuns`).get()).docs.map((d) => d.ref));
  await db.doc(`tenants/${T2}/metaCatalogImportState/current`).delete().catch(() => {});
  await setFixture(Array.from({ length: 30 }, (_, i) => item(`HDGEN-${String(i + 1).padStart(2, '0')}`, {
    name: `Articulo Generacional ${i + 1}`, description: `Articulo generacional ${i + 1} linea corta`, brand: 'MarcaGen',
  })), { pagesPerList: 6 });

  const { result: r1 } = await runImport(ownerBoutique, { maxPages: 1 });
  const st1 = await stateOf(T2);
  const run1 = await runDocOf(T2, r1?.runId);
  check('HD-8. el PRIMER claim fija generation=1 en el puntero Y copiada al run', r1?.status === 'running' && st1?.generation === 1 && run1?.generation === 1 && st1?.activeRunId === r1?.runId, `gen=${st1?.generation}`);

  const { result: r2 } = await runImport(ownerBoutique, { maxPages: 1 });
  const st2 = await stateOf(T2);
  const run2 = await runDocOf(T2, r1?.runId);
  check('HD-8b. el takeover tras lease liberada INCREMENTA la generación (mismo run, claim nuevo persistido)', r2?.runId === r1?.runId && st2?.generation === 2 && run2?.generation === 2, `gen=${st2?.generation}`);

  const { settleImportRunIfOwner, firestoreImportStore, emptyImportCounters, ImportRunClaimLostError } =
    await import(new URL('../lib/meta/catalogImport.js', import.meta.url).href);
  const zombi = firestoreImportStore({ tenantId: T2, runId: r1?.runId, profile: null, generation: 1 });
  const preZombi = (await db.doc(`tenants/${T2}/metaCatalogImportRuns/${r1?.runId}`).get()).updateTime.toMillis();

  const settleViejo = await settleImportRunIfOwner(T2, r1?.runId, 1, { lastError: 'escritura-zombi' });
  let claimLostCreate = false;
  try {
    await zombi.createImported({ productId: 'meta_HDGEN-ZOMBIE', lockKey: 'HDGEN-ZOMBIE', retailerId: 'HDGEN-ZOMBIE', doc: { id: 'meta_HDGEN-ZOMBIE', tenantId: T2, name: 'Producto Zombi Tardio' } });
  } catch (e) { claimLostCreate = e instanceof ImportRunClaimLostError; }
  let claimLostProgress = false;
  try {
    await zombi.saveProgress({ status: 'completed', cursor: null, counters: emptyImportCounters(), blockedByReason: {}, pagesDone: 99, processed: 999 });
  } catch (e) { claimLostProgress = e instanceof ImportRunClaimLostError; }

  const runTrasZombi = await runDocOf(T2, r1?.runId);
  const stTrasZombi = await stateOf(T2);
  const timeTrasZombi = (await db.doc(`tenants/${T2}/metaCatalogImportRuns/${r1?.runId}`).get()).updateTime.toMillis();
  check('HD-8c. la generación SUPERADA no asienta nada: settle ⇒ false y el run doc byte-idéntico', settleViejo === false && timeTrasZombi === preZombi && runTrasZombi?.lastError === '');
  check('HD-8d. claim_lost REAL del store: crear producto+lock con generación vieja LANZA y no escribe', claimLostCreate === true && (await productOf(T2, 'meta_HDGEN-ZOMBIE')) === null && !(await db.doc(`tenants/${T2}/metaRetailerLocks/HDGEN-ZOMBIE`).get()).exists);
  check('HD-8e. el zombi tampoco cierra el run ni libera el puntero de otro (saveProgress ⇒ claim_lost)', claimLostProgress === true && runTrasZombi?.status === 'running' && runTrasZombi?.pagesDone === 2 && stTrasZombi?.activeRunId === r1?.runId);
  const settleVigente = await settleImportRunIfOwner(T2, r1?.runId, 2, { lastError: '' });
  check('HD-8f. el MISMO settle con la generación VIGENTE sí asienta (discrimina por generación, no por suerte)', settleVigente === true);

  // HD-8g'. Guard monotónico del STORE REAL: generación VIGENTE pero progreso MENOR al
  // persistido ⇒ la escritura se descarta y el run doc queda intacto (espejo E2E del unit
  // importProgressRegression; NOTA de cobertura de la review HARDEN-1).
  {
    const vigente = firestoreImportStore({ tenantId: T2, runId: r1?.runId, profile: null, generation: 2 });
    const antesMono = await runDocOf(T2, r1?.runId);
    await vigente.saveProgress({ status: 'running', cursor: antesMono?.cursor ?? null, counters: emptyImportCounters(), blockedByReason: {}, pagesDone: Math.max(0, (antesMono?.pagesDone ?? 1) - 1), processed: 0 });
    const trasMono = await runDocOf(T2, r1?.runId);
    check("HD-8g'. progreso MENOR con generación vigente ⇒ descartado: pagesDone/procesados no retroceden", trasMono?.pagesDone === antesMono?.pagesDone && trasMono?.processed === antesMono?.processed && trasMono?.status === 'running', `pages=${trasMono?.pagesDone}`);
  }

  let fin = r2;
  for (let i = 0; i < 8 && fin?.status !== 'completed'; i++) fin = (await runImport(ownerBoutique, { maxPages: 10 })).result;
  const stFin = await stateOf(T2);
  const runFin = await runDocOf(T2, r1?.runId);
  check('HD-8g. el claim vigente completa el run; generación final persistida coincide puntero↔run y nada tardío apareció', fin?.status === 'completed' && runFin?.status === 'completed' && runFin?.generation === stFin?.generation && stFin?.generation >= 3 && stFin?.activeRunId === null && (await productOf(T2, 'meta_HDGEN-ZOMBIE')) === null, `gen=${stFin?.generation}`);
}

// ═══ HD-10. La campana catalog_quality es CONSULTABLE por query bajo rules (manager sí, seller no) ═══
{
  const structuredQuery = {
    structuredQuery: {
      from: [{ collectionId: 'notifications' }],
      where: { fieldFilter: { field: { fieldPath: 'category' }, op: 'EQUAL', value: { stringValue: 'catalog_quality' } } },
      limit: 10,
    },
  };
  const runQueryNotifs = async (token) => {
    const res = await fetch(`${FS}/tenants/${T}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(structuredQuery) });
    const body = await res.json().catch(() => null);
    const rows = Array.isArray(body) ? body : [];
    return { status: res.status, denied: res.status !== 200 || rows.some((r) => r?.error), names: rows.filter((r) => r?.document).map((r) => r.document.name) };
  };
  const qManager = await runQueryNotifs(manager);
  check('HD-10. la QUERY de igualdad category==catalog_quality DEVUELVE la campana al MANAGER (rules)', qManager.denied === false && qManager.names.some((n) => n.endsWith(`notifications/catalog-quality-${T}`)), `status=${qManager.status} docs=${qManager.names.length}`);
  const qSeller = await runQueryNotifs(seller);
  check('HD-10b. la MISMA query como SELLER queda DENEGADA por rules', qSeller.denied === true && qSeller.names.length === 0, `status=${qSeller.status}`);
}

// ═══ HD-11. Cierre HARDEN-1: tampoco esta sección escribió NADA hacia Meta ═══
{
  check('HD-11. HARDEN-1 completo sin tocar Meta: cero batches escritos por el fake', (await writesSnap()).empty);
}

// ═══ Limpieza final (deja el emulador listo para verify-meta-catalog) ═══
await wipePrograma();
await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});
// El perfil de vertical se limpia también: verify-meta-catalog siembra el suyo en su setup.
await db.doc(`tenants/${T}/config/catalog`).delete().catch(() => {});
await db.doc(`tenants/${T}`).set({ limitOverrides: FieldValue.delete() }, { merge: true });
await setFixture([]);

// ═══ Resultado ═══
const okCount = results.filter(Boolean).length;
console.log(`\nRESULTADO CATALOG-ONBOARDING (E2E fake): ${okCount === results.length ? 'TODO OK ✅' : 'FALLAS ❌'} (${okCount}/${results.length})`);
process.exit(okCount === results.length ? 0 : 1);
