/**
 * verify-ownership-model.mjs — META-CATALOG-OWNERSHIP-MODEL-1 / ADR-0015 (emulador limpio).
 * PROPIEDAD POR CAMPOS del catálogo, estado ACTUAL honesto y guards de venta, con cliente FAKE
 * por fixtures (JAMÁS Meta real, cero escrituras hacia el catálogo salvo las que el propio
 * escenario exige y que se cuentan una por una):
 *   fail-closed de nivel 2 (config legacy/ausente/malformada/contradictoria), los tres modelos
 *   (external_managed sin jobs ni opt-in, hybrid campo por campo), detección de fuentes externas
 *   con bloqueo de escrituras y alerta agregada idempotente, saneamiento del secreto del feed,
 *   reconciliación (verified / drifted_external / remote_missing / unverifiable / stale derivado),
 *   revalidación de propiedad antes del POST, ausencia de loop diario, guard de bot y checkout
 *   con handoff idempotente, aislamiento cross-tenant, roles, credipower intocado y la migración
 *   preview/apply que deja a "arfagi" en external_managed con Odyssey en drifted_external.
 *
 * OW-18 a OW-21 cierran el hueco de cobertura que el propio E2E reportó (arreglos que hasta ahora
 * solo tenían tests unitarios): la INTERSECCIÓN "pagar" ∧ "ver carrito" —que termina en la vista de
 * carrito, no en el checkout—, la rama de REUSO del pedido abierto fallando CERRADO, la
 * reconciliación corriendo con la sincronización APAGADA pero con gobierno externo declarado (si el
 * guard está prendido, lo que refresca la evidencia también tiene que poder correr) y el vínculo
 * manual legacy mapeado SOLO por `metaProductItemId`, que no puede quedar trabado en `unverifiable`.
 *
 * Requiere: emuladores (auth+functions+firestore+storage) + seed-users + load-catalog.
 * Checks numerados OW-N (uno por punto del programa; letras = sub-asserts).
 *
 * OW-6 (el secreto del feed jamás se persiste NI SE LOGUEA) necesita ver la salida del emulador:
 * exportá `E2E_EMULATOR_LOG` con la ruta del archivo donde se está capturando esa salida. Sin
 * esa variable el check FALLA a propósito — "no lo pude mirar" no es "no está".
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

initializeApp({ projectId: 'demo-aiafg' });
const db = getFirestore();
const adminAuth = getAuth();
const BASE = 'http://127.0.0.1:5001/demo-aiafg/us-central1';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-aiafg/databases/(default)/documents';
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key';
const T = 'perfumeria'; // el "arfagi" de este E2E: catálogo gobernado por el feed de su sitio
const T2 = 'boutique-demo';
const T3 = 'credipower'; // SIN config de catálogo: fail-closed de nivel 1, jamás toca Meta
const CATALOG_ID = 'CAT-OWN-1';
const OTRO_CATALOGO = 'CAT-OWN-OTRO';
const FIXTURE = 'metaTestFixtures/catalog';

const results = [];
const check = (n, c, e = '') => { results.push(!!c); console.log(`${c ? '✅' : '❌'} ${n}${e ? '  — ' + e : ''}`); };
const signIn = async (email) => (await (await fetch(AUTH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }) })).json()).idToken;
async function call(name, token, data) {
  const res = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ data }) });
  const body = await res.json().catch(() => ({}));
  return { result: body.result, err: body.error?.status ?? null, errMsg: body.error?.message ?? null };
}
// El "cliente" de las pruebas de rules ES la API REST de Firestore con el idToken del usuario.
const restGet = (path, token) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
/** Mensaje del cliente por el MOTOR real (mismo camino que el webhook, sin WhatsApp). */
const bot = async (from, text, tenantId = T) =>
  (await (await fetch(`${BASE}/devMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, text, tenantId }) })).json().catch(() => ({})));
/** Mantenimiento del outbox de UN tenant (sweep + drenaje + confirmación). */
const drain = async (tenantId = T, graceMs = 0) =>
  (await (await fetch(`${BASE}/devRunMetaCatalogOutbox?tenantId=${encodeURIComponent(tenantId)}&graceMs=${graceMs}`, { headers: { 'x-dev-key': 'dev-local' } })).json().catch(() => ({}))).result ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = Timestamp.now();

// ═══════════════════════════════════════════════════════════════════════════
// Fixture del fake: artículos remotos + FUENTES DE DATOS crudas (con token)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * El secreto que el feed lleva en su URL firmada. Aparece en el fixture (como aparecería en el
 * Graph real) y NO puede sobrevivir en ningún documento ni en ningún log: OW-6 lo persigue.
 */
const FEED_TOKEN = 'SECRETO-FEED-TOKEN-9f3a2b';
const FEED_URL = `https://tienda.e2e.test/feeds/products.csv?access_token=${FEED_TOKEN}&sig=firma`;
const COLUMNAS = ['id', 'title', 'description', 'price', 'availability', 'brand', 'image_link', 'link', 'google_product_category', 'quantity_to_sell_on_facebook'];
/** Campos públicos que el feed publica según sus columnas (el orden es el canónico del contrato). */
const CAMPOS_DEL_FEED = ['title', 'description', 'price', 'availability', 'inventory', 'brand', 'category', 'image', 'url'];
/**
 * Contrato público COMPLETO (`WRITABLE_FIELDS`). Con `external_managed` la propiedad efectiva de
 * la fuente externa es esta lista entera, publique o no cada columna: el modelo ya declara que el
 * gobierno de lo público es de afuera y `ownedFields` está vacío por definición.
 */
const CAMPOS_PUBLICOS = ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'category', 'image', 'url'];

const feedCrudo = (over = {}) => ({
  id: 'ds-feed-1',
  // Un humano pudo bautizar el feed pegando la URL firmada entera: así llega del Graph.
  name: `Feed diario del sitio ${FEED_URL}`,
  file_name: `products.csv?access_token=${FEED_TOKEN}`,
  created_time: '2026-01-15T03:33:00+0000',
  schedule: { interval: 'DAILY', hour: '3', minute: '33', timezone: 'America/Asuncion', url: FEED_URL },
  columns: COLUMNAS,
  ...over,
});
const feedNuevoCrudo = () => feedCrudo({ id: 'ds-feed-2', name: 'Feed suplementario de promociones', schedule: { interval: 'HOURLY', hour: '0', minute: '15', timezone: 'America/Asuncion', url: 'https://promos.e2e.test/extra.csv?access_token=OTRO-SECRETO' } });

const IMG = (id) => `https://cdn.e2e.test/own/${id}.jpg`;
const URLP = (id) => `https://tienda.e2e.test/p/${id}`;
/** Artículo REMOTO tal como lo devuelve el contrato de LECTURA del Graph (snake_case). */
const remoto = (rid, over = {}) => ({
  id: `itm-${rid}`, retailer_id: rid, name: `Producto ${rid}`, description: `Descripcion publica de ${rid}`,
  availability: 'in stock', price: '₲250.000', image_url: IMG(rid), brand: 'MarcaOwn',
  url: URLP(rid), condition: 'new', ...over,
});

const setFixture = (items, extra = {}) =>
  db.doc(FIXTURE).set({ catalog: { id: CATALOG_ID, name: 'Catálogo Ownership E2E' }, items, dataSourcesDetectedAt: '2026-07-30T09:00:00.000Z', ...extra });
const setFuentes = (dataSources, extra = {}) => db.doc(FIXTURE).set({ dataSources, ...extra }, { merge: true });
const writesSnap = () => db.collection(`${FIXTURE}/writes`).get();
const wipeWrites = async () => { const s = await writesSnap(); await Promise.all(s.docs.map((d) => d.ref.delete())); };
const idsEnviados = async () => (await writesSnap()).docs.flatMap((d) => (d.data().requests ?? []).map((r) => r.data?.id));

// ═══════════════════════════════════════════════════════════════════════════
// Config: la propiedad se escribe COMPLETA (nunca merge: un merge de mapas dejaría
// sobrevivir la `ownership` del escenario anterior y el fail-closed sería un espejismo).
// ═══════════════════════════════════════════════════════════════════════════
const setCfg = (tenant, catalogSync) => db.doc(`tenants/${tenant}/config/meta`).set({ catalogSync });
const cfgOf = async (tenant) => (await db.doc(`tenants/${tenant}/config/meta`).get()).data()?.catalogSync ?? null;

/** Config LEGACY: exactamente lo que había en producción antes de ADR-0015. */
const CFG_LEGACY = { enabled: true, mode: 'live', catalogId: CATALOG_ID, sourceOfTruth: 'vendeyapy' };

const productOf = async (id, tenant = T) => (await db.doc(`tenants/${tenant}/products/${id}`).get()).data() ?? null;
const jobsOf = async (tenant = T) => (await db.collection(`tenants/${tenant}/metaCatalogOutboxJobs`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const jobDe = async (productId, tenant = T) => (await jobsOf(tenant)).find((j) => j.productId === productId) ?? null;
const sourceChecks = async (tenant = T) => (await db.collection(`tenants/${tenant}/metaCatalogSourceChecks`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const notifsDe = async (categoria, tenant = T) => (await db.collection(`tenants/${tenant}/notifications`).where('category', '==', categoria).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const sessionOf = async (cid, tenant = T) => (await db.doc(`tenants/${tenant}/customers/${cid}/sessions/active`).get()).data() ?? null;
const ordersDe = async (cid, tenant = T) => (await db.collection(`tenants/${tenant}/orders`).where('customerId', '==', cid).get()).docs.map((d) => d.data());

async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = db.batch();
    for (const r of refs.slice(i, i + 400)) b.delete(r);
    await b.commit();
  }
}
const wipeCol = async (path) => deleteRefs((await db.collection(path).get()).docs.map((d) => d.ref));

// ═══════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ META-CATALOG-OWNERSHIP-MODEL-1 (ADR-0015) · E2E con cliente fake (cero Meta real) ═══\n');

const PREFIJO = 'OWN-';
const CLIENTES = [
  '595981700001', '595981700002', '595981700003', '595981700004',
  // OW-18/OW-19: cada corrida arranca en una SESIÓN NUEVA y una sesión nueva es un cliente nuevo
  // (el primer turno persiste el takeover y silencia los siguientes: ese es el comportamiento
  // idempotente esperado, así que reusar el cliente escondería el turno que se quiere probar).
  '595981700011', '595981700012', '595981700013', '595981700014', // A1 · variante CART
  '595981700021', '595981700022', '595981700023', '595981700024', // A1 · variante AWAITING_PAYMENT
  '595981700031', '595981700032', // A1 · control negativo N1 (producto verified: sí se cotiza)
  '595981700041', // A1 · control negativo N2 (pago PURO: lo frena el checkout, no el guard)
  '595981700051', '595981700052', '595981700053', '595981700054', '595981700055', '595981700056', // A2
  // A2 · fail-closed ACOTADO: la lectura se cae sobre un pedido SIN nada publicado en Meta
  '595981700061', '595981700062',
];

/** Limpieza idempotente: el script se puede re-correr sin reiniciar el emulador. */
async function wipePrograma() {
  for (const tenant of [T, T2, T3]) {
    await wipeCol(`tenants/${tenant}/metaCatalogSourceChecks`);
    await wipeCol(`tenants/${tenant}/metaCatalogVerificationRuns`);
    await wipeCol(`tenants/${tenant}/metaCatalogOwnershipRuns`);
    await wipeCol(`tenants/${tenant}/metaCatalogOutboxJobs`);
    await wipeCol(`tenants/${tenant}/metaCatalogOutboxIntents`);
    await wipeCol(`tenants/${tenant}/metaCatalogSyncRuns`);
    await deleteRefs((await db.collection(`tenants/${tenant}/notifications`).where('category', '==', 'catalog_source').get()).docs.map((d) => d.ref));
    // La campana de "no podemos verificar" (config contradictoria) es determinística por tenant:
    // si sobrevive de una corrida anterior, el escenario de OW-20 arrancaría con el aviso abierto.
    await deleteRefs((await db.collection(`tenants/${tenant}/notifications`).where('category', '==', 'catalog_verification').get()).docs.map((d) => d.ref));
    await deleteRefs((await db.collection(`tenants/${tenant}/products`).get()).docs.filter((d) => d.id.startsWith(PREFIJO)).map((d) => d.ref));
    await db.doc(`tenants/${tenant}/_debug/catalogFixtures`).delete().catch(() => {});
    // Falla inyectada en la proyección de deriva (OW-19): un fixture viejo dejaría al bot mudo
    // sobre el tenant entero, y el "fail-closed" de los otros grupos sería un espejismo.
    await db.doc(`tenants/${tenant}/_debug/driftFixtures`).delete().catch(() => {});
    // El testigo del hook de pausa TAMBIÉN se borra: un `catalogHolds` viejo (de otro harness)
    // haría que `waitHold` devuelva true al instante y el escenario de carrera sería falso.
    await db.doc(`tenants/${tenant}/_debug/catalogHolds`).delete().catch(() => {});
  }
  for (const c of CLIENTES) {
    await db.doc(`tenants/${T}/customers/${c}/sessions/active`).delete().catch(() => {});
    await deleteRefs((await db.collection(`tenants/${T}/customers/${c}/messages`).get()).docs.map((d) => d.ref));
    await db.doc(`tenants/${T}/customers/${c}`).delete().catch(() => {});
    await deleteRefs((await db.collection(`tenants/${T}/orders`).where('customerId', '==', c).get()).docs.map((d) => d.ref));
    await deleteRefs((await db.collection(`tenants/${T}/notifications`).where('customerId', '==', c).get()).docs.map((d) => d.ref));
  }
  await wipeWrites();
}
await wipePrograma();

// Productos AJENOS al programa: nunca deben entrar a un plan ni a una reconciliación de este
// E2E (residuos de otros harnesses falsearían todos los contadores exactos). Los mapeados se
// borran —verify-meta-catalog los recrea en su propio setup— y al resto se le apaga el opt-in.
for (const tenant of [T, T2]) {
  const prods = await db.collection(`tenants/${tenant}/products`).get();
  const mapeadosAjenos = prods.docs.filter((d) => !d.id.startsWith(PREFIJO) && !!(d.data().metaRetailerId ?? '').trim());
  await deleteRefs(mapeadosAjenos.map((d) => d.ref));
  for (const d of prods.docs) {
    if (d.id.startsWith(PREFIJO) || mapeadosAjenos.some((m) => m.id === d.id)) continue;
    if (d.data().syncToMeta === true) await d.ref.set({ syncToMeta: false }, { merge: true });
  }
}

const tenantBase = (id, name) => ({
  name, slug: id, status: 'ACTIVE', planId: 'growth',
  subscription: { status: 'active', currentPeriodStart: now },
  usage: { messagesThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
  updatedAt: now,
});
await db.doc(`tenants/${T}`).set(tenantBase(T, 'Perfumería E2E'), { merge: true });
await db.doc(`tenants/${T2}`).set(tenantBase(T2, 'Boutique E2E'), { merge: true });
await db.doc(`tenants/${T3}`).set(tenantBase(T3, 'CrediPower E2E'), { merge: true });
// credipower NO tiene config de catálogo: es el fail-closed de nivel 1 (ADR-0015 §2).
await db.doc(`tenants/${T3}/config/meta`).delete().catch(() => {});
await db.doc(`tenants/${T}/categories/perfumes`).set({ id: 'perfumes', tenantId: T, name: 'Perfumes', isActive: true, position: 0, createdAt: now, updatedAt: now }, { merge: true });
await db.doc(`tenants/${T2}/categories/general`).set({ id: 'general', tenantId: T2, name: 'General', isActive: true, position: 0, createdAt: now, updatedAt: now }, { merge: true });
// El bot tiene que poder derivar a ALGUIEN (si no, la deriva responde honesta pero sin pase).
const checkoutPrevio = (await db.doc(`tenants/${T}/config/checkout`).get()).data() ?? null;
await db.doc(`tenants/${T}/config/checkout`).set({ sellers: [{ name: 'Ana Ownership', whatsapp: '595991000077', active: true }] }, { merge: true });
await db.doc(`tenants/${T}/config/agent`).set({ botEnabled: true, greetingMessage: 'Hola, soy el bot de la prueba' }, { merge: true });
await db.doc(`tenants/${T}/config/channels`).set({ whatsappSendMode: 'mock' }, { merge: true });

/** Manager real del tenant (los seeds no lo traen y OW-15 exige probar el rol, no un proxy). */
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

// ── Productos del programa (T) ────────────────────────────────────────────
const prod = (id, over = {}) => ({
  id, tenantId: T, name: `Producto ${id}`, description: `Descripcion publica de ${id}`,
  price: 250000, compareAtPrice: null, aiNotes: `INTERNO-${id}`, currency: 'PYG', categoryId: 'perfumes',
  images: [IMG(id)], emoji: '🌸', inventory: { trackStock: true, stock: 5, lowStockThreshold: 1, sku: id },
  status: 'ACTIVE', featured: false, position: 80, externalIds: { facebook: null, instagram: null, tiktok: null },
  brand: 'MarcaOwn', perfume: null, aiFicha: null, productUrl: URLP(id), syncToMeta: false,
  createdAt: now, updatedAt: now, ...over,
});
/** Identidad remota + histórico de una escritura confirmada (el `synced` que nada caducaba). */
const mapeado = (rid, over = {}) => ({
  metaRetailerId: rid, metaCatalogId: CATALOG_ID, metaProductItemId: `itm-${rid}`,
  metaSyncStatus: 'synced', metaLastSyncAt: Timestamp.fromMillis(Date.now() - 11 * 3600_000), ...over,
});

const P_ODYSSEY = 'OWN-ODYSSEY';
const P_VERIF = 'OWN-VERIF';
const P_GONE = 'OWN-GONE';
const P_OTRO = 'OWN-OTRO';
const P_LOCAL = 'OWN-LOCAL';
const P_HYB = 'OWN-HYB';
const P_HYBT = 'OWN-HYBT';

async function sembrarProductos() {
  const b = db.batch();
  // El caso Odyssey: VINCULADO A MANO (nunca importado), local ₲250.000, remoto ₲130.000.
  b.set(db.doc(`tenants/${T}/products/${P_ODYSSEY}`), prod(P_ODYSSEY, {
    name: 'Odyssey Ownership', description: 'Descripcion publica de OWN-ODYSSEY', price: 250000,
    images: [IMG(P_ODYSSEY)], productUrl: URLP(P_ODYSSEY), syncToMeta: true, ...mapeado(P_ODYSSEY),
  }));
  b.set(db.doc(`tenants/${T}/products/${P_VERIF}`), prod(P_VERIF, { syncToMeta: true, ...mapeado(P_VERIF) }));
  b.set(db.doc(`tenants/${T}/products/${P_GONE}`), prod(P_GONE, { ...mapeado(P_GONE) }));
  // Vinculado a OTRO catálogo: no leímos ese catálogo, así que no se puede afirmar nada de él.
  b.set(db.doc(`tenants/${T}/products/${P_OTRO}`), prod(P_OTRO, { ...mapeado(P_OTRO), metaCatalogId: OTRO_CATALOGO }));
  b.set(db.doc(`tenants/${T}/products/${P_LOCAL}`), prod(P_LOCAL, { name: 'Local Sin Meta Ownership' }));
  // Híbrido: el título lo publica el feed, el precio lo gobernamos nosotros.
  b.set(db.doc(`tenants/${T}/products/${P_HYB}`), prod(P_HYB, { name: 'Hibrido Precio Ownership', price: 310000, syncToMeta: true, ...mapeado(P_HYB) }));
  b.set(db.doc(`tenants/${T}/products/${P_HYBT}`), prod(P_HYBT, { name: 'Hibrido Solo Titulo Ownership', syncToMeta: true, ...mapeado(P_HYBT) }));
  await b.commit();
}
await sembrarProductos();

/** Catálogo remoto del escenario. Odyssey a ₲130.000 = el feed que revirtió nuestro canary. */
const ITEMS_BASE = () => [
  remoto(P_ODYSSEY, { name: 'Odyssey Ownership', description: 'Descripcion publica de OWN-ODYSSEY', price: '₲130.000', image_url: IMG(P_ODYSSEY), url: URLP(P_ODYSSEY) }),
  remoto(P_VERIF),
  remoto(P_HYB, { name: 'Hibrido Precio Ownership', price: '₲250.000' }), // el precio (NUESTRO) difiere
  remoto(P_HYBT, { name: 'Titulo Que Publica El Feed' }), // solo el título (AJENO) difiere
  remoto('OWN-REMOTO-SOLO'), // artículo remoto sin producto local: solo se cuenta
];
// El feed que gobierna el catálogo está presente DESDE EL PRINCIPIO: es el hecho que la
// auditoría encontró en producción, no un evento del escenario.
await setFixture(ITEMS_BASE(), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });

// Huellas REALES calculadas con el MISMO código del backend (lib compilada): el reconocimiento
// que escribe la migración y el que verifica el gate tienen que ser el mismo valor.
const { catalogSourceFingerprint } = await import(new URL('../lib/meta/catalogSourceDetection.js', import.meta.url).href);
const { sanitizeDataSource } = await import(new URL('../lib/meta/catalogClient.js', import.meta.url).href);
const huellaDe = (crudas) => catalogSourceFingerprint(crudas.map((c) => sanitizeDataSource(c, '2026-07-30T09:00:00.000Z')).filter(Boolean));
const HUELLA_FEED = huellaDe([feedCrudo()]);

// ── Declaraciones de propiedad usadas por los escenarios ──────────────────
const externaReconocida = (over = {}) => ({
  kind: 'meta_feed', acknowledgedSourceIds: ['ds-feed-1'], declaredFields: CAMPOS_DEL_FEED,
  fingerprint: HUELLA_FEED, acknowledgedAt: now, acknowledgedByUid: 'uid-owner-e2e', ...over,
});
const OWN_EXTERNA = { model: 'external_managed', ownedFields: [], external: externaReconocida(), lastSourceCheckAt: now };
/** Híbrido: nosotros el precio/moneda/disponibilidad/stock; el feed, todo lo descriptivo. */
const CAMPOS_PROPIOS_HIBRIDO = ['price', 'currency', 'availability', 'inventory'];
const OWN_HIBRIDA = {
  model: 'hybrid', ownedFields: CAMPOS_PROPIOS_HIBRIDO,
  external: externaReconocida({ declaredFields: ['title', 'description', 'brand', 'category', 'image', 'url'] }),
  lastSourceCheckAt: now,
};

// Preview/apply del ciclo de catálogo (mismo helper que verify-meta-catalog: el apply viaja
// SIEMPRE atado a la evidencia del preview aprobado).
const preview = async (token, data = {}) => (await call('runTenantJob', token, { action: 'catalogSync', ...data })).result?.result ?? null;
async function aplicar(token, data = {}) {
  const p = await preview(token, data);
  if (!p?.planHash) return { res: null, preview: p };
  const r = await call('runTenantJob', token, { action: 'catalogSyncApply', ...data, args: { previewRunId: p.runId, planHash: p.planHash } });
  // `errMsg` viaja también: los checks del gate de relación (ADR-0022) asertan el mensaje.
  return { res: r.result?.result ?? null, err: r.err, errMsg: r.errMsg, preview: p };
}
const entradaDe = (plan, productId) => (plan?.entries ?? []).find((e) => e.productId === productId) ?? null;

// ═══════════════════════════════════════════════════════════════════════════
// OW-1. Config LEGACY (solo sourceOfTruth) ⇒ cero campos escribibles,
//       apply bloqueado y modo efectivo dry_run aunque la config diga `live`.
// ═══════════════════════════════════════════════════════════════════════════
{
  await setCfg(T, CFG_LEGACY); // mode: 'live' a propósito
  const p = await preview(owner);
  check('OW-1. config LEGACY (solo sourceOfTruth) ⇒ propiedad DEGRADADA con cero campos escribibles',
    p?.ownership?.degraded === true && (p?.ownership?.ownedFields ?? ['x']).length === 0 && (p?.ownership?.reasons ?? []).includes('ownership_missing'),
    `degraded=${p?.ownership?.degraded} reasons=${JSON.stringify(p?.ownership?.reasons)}`);
  check('OW-1b. el modo EFECTIVO cae a dry_run aunque el documento diga live (el techo manda)',
    p?.configMode === 'live' && p?.effectiveMode === 'dry_run', `config=${p?.configMode} efectivo=${p?.effectiveMode}`);
  // (ADR-0022 §4) La propiedad degradada deriva relación `mirror` y publicar quedó detrás del
  // gate de relación: el apply se RECHAZA explícito (failed-precondition con el motivo de
  // espejo) ANTES de correr — más cerrado que el `apply_blocked` histórico. El espíritu es el
  // mismo y OW-1d lo sigue probando con datos: cero jobs, cero escrituras.
  const { res, err, errMsg } = await aplicar(owner);
  check('OW-1c. el apply queda RECHAZADO por el gate de relación (espejo: escribir hacia Meta está bloqueado)',
    res === null && err === 'FAILED_PRECONDITION' && /espejo/i.test(String(errMsg ?? '')), `err=${err} msg=${String(errMsg ?? '').slice(0, 70)}`);
  check('OW-1d. ningún job encolado y CERO escrituras hacia Meta', (await jobsOf()).length === 0 && (await writesSnap()).empty);
  // Sin ownership NO hay patch posible: el plan no propone una sola acción accionable.
  const accionables = (p?.entries ?? []).filter((e) => ['create', 'update', 'disable'].includes(e.action));
  check('OW-1e. el plan no propone NI UNA acción accionable (todo lo bloquea la propiedad)',
    accionables.length === 0 && (p?.ownership?.blockedActions ?? 0) > 0, `accionables=${accionables.length} bloqueadas=${p?.ownership?.blockedActions}`);
  const conMotivo = (p?.entries ?? []).filter((e) => (e.blockedReasons ?? []).includes('externally_owned'));
  check('OW-1f. y cada bloqueo dice POR QUÉ (externally_owned + nota "propiedad_no_declarada")',
    conMotivo.length > 0 && conMotivo.every((e) => e.note === 'propiedad_no_declarada'), `entradas=${conMotivo.length} nota=${conMotivo[0]?.note}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-2. Config MALFORMADA y CONTRADICCIÓN de propietarios ⇒ degradada con el motivo correcto
// ═══════════════════════════════════════════════════════════════════════════
{
  const motivoDe = async (ownership) => {
    await setCfg(T, { ...CFG_LEGACY, ownership });
    return (await preview(owner))?.ownership ?? null;
  };
  const malformada = await motivoDe('no-soy-un-objeto');
  check('OW-2. ownership que no es un objeto ⇒ ownership_malformed (cero campos escribibles)',
    malformada?.degraded === true && (malformada?.reasons ?? []).includes('ownership_malformed') && malformada.ownedFields.length === 0,
    JSON.stringify(malformada?.reasons));
  const modeloDesconocido = await motivoDe({ model: 'vendeyapy_manda_siempre', ownedFields: ['price'], external: null });
  check('OW-2b. modelo desconocido ⇒ ownership_malformed (jamás se interpreta como permiso)',
    modeloDesconocido?.degraded === true && (modeloDesconocido?.reasons ?? []).includes('ownership_malformed'), JSON.stringify(modeloDesconocido?.reasons));
  const contradictoria = await motivoDe({
    model: 'hybrid', ownedFields: ['price', 'title'],
    external: externaReconocida({ declaredFields: ['title', 'description'] }),
  });
  check('OW-2c. el MISMO campo declarado por los dos lados ⇒ ownership_conflict (un campo, un dueño)',
    contradictoria?.degraded === true && (contradictoria?.reasons ?? []).includes('ownership_conflict') && contradictoria.ownedFields.length === 0,
    JSON.stringify(contradictoria?.reasons));
  const interna = await motivoDe({ model: 'vendeyapy_managed', ownedFields: ['price', 'cost'], external: null });
  check('OW-2d. declarar un campo INTERNO (costo) ⇒ ownership_never_publishable, no un permiso parcial',
    interna?.degraded === true && (interna?.reasons ?? []).includes('ownership_never_publishable'), JSON.stringify(interna?.reasons));
  const externaSinFuente = await motivoDe({ model: 'external_managed', ownedFields: [], external: null });
  check('OW-2e. external_managed SIN fuente reconocida ⇒ external_required ("manda otro" sin decir quién no vale)',
    externaSinFuente?.degraded === true && (externaSinFuente?.reasons ?? []).includes('external_required'), JSON.stringify(externaSinFuente?.reasons));
  const externaSinIds = await motivoDe({ model: 'external_managed', ownedFields: [], external: externaReconocida({ acknowledgedSourceIds: [] }) });
  check('OW-2f. un feed "reconocido" SIN ids ⇒ external_declaration_invalid (una promesa vacía)',
    externaSinIds?.degraded === true && (externaSinIds?.reasons ?? []).includes('external_declaration_invalid'), JSON.stringify(externaSinIds?.reasons));
  const hibridoSinMatriz = await motivoDe({ model: 'hybrid', ownedFields: ['price'], external: null });
  check('OW-2g. hybrid sin la matriz de los DOS lados ⇒ hybrid_partition_missing (jamás se infiere)',
    hibridoSinMatriz?.degraded === true && (hibridoSinMatriz?.reasons ?? []).includes('hybrid_partition_missing'), JSON.stringify(hibridoSinMatriz?.reasons));
  check('OW-2h. ninguna de las siete configuraciones inválidas encoló un job ni tocó Meta',
    (await jobsOf()).length === 0 && (await writesSnap()).empty);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-3. external_managed: plan sin acciones, CERO jobs aunque el modo sea live, opt-in bloqueado
// ═══════════════════════════════════════════════════════════════════════════
{
  await setCfg(T, { ...CFG_LEGACY, mode: 'live', ownership: OWN_EXTERNA });
  const p = await preview(owner);
  // Con `external_managed` el gobierno externo EFECTIVO son TODOS los campos públicos, no solo
  // los que el feed enumeró: `ownedFields` es vacío por definición del modelo, y una lista corta
  // dejaba inerte el guard de deriva del bot (campos externos vacíos ⇒ "sin deriva").
  check('OW-3. external_managed sano ⇒ propiedad NO degradada, cero campos propios, TODOS los públicos afuera',
    p?.ownership?.degraded === false && p?.ownership?.model === 'external_managed' && p.ownership.ownedFields.length === 0 &&
    JSON.stringify(p.ownership.externalFields) === JSON.stringify(CAMPOS_PUBLICOS),
    `model=${p?.ownership?.model} externos=${JSON.stringify(p?.ownership?.externalFields)}`);
  const accionables = (p?.entries ?? []).filter((e) => ['create', 'update', 'disable'].includes(e.action));
  check('OW-3b. el plan no tiene NI UNA acción accionable y el modo efectivo es dry_run con la config en live',
    accionables.length === 0 && p?.configMode === 'live' && p?.effectiveMode === 'dry_run', `accionables=${accionables.length} efectivo=${p?.effectiveMode}`);
  const odyssey = entradaDe(p, P_ODYSSEY);
  check('OW-3c. Odyssey (precio divergente) queda BLOQUEADO por propiedad, con la nota de fuente externa',
    odyssey?.action === 'blocked' && (odyssey?.blockedReasons ?? []).includes('externally_owned') && odyssey?.note === 'campos_gobernados_por_fuente_externa',
    `action=${odyssey?.action} nota=${odyssey?.note}`);
  // (ADR-0022 §4) external_managed deriva `mirror`: el gate de relación rechaza el apply
  // ANTES del techo de propiedad (que sigue ahí abajo, intacto). Igual de duro: cero jobs y
  // cero escrituras con la config en live.
  const { res, err } = await aplicar(owner);
  check('OW-3d. el apply no pasa (gate de relación mirror): CERO jobs encolados con mode:live',
    res === null && err === 'FAILED_PRECONDITION' && (await jobsOf()).length === 0 && (await writesSnap()).empty,
    `err=${err} jobs=${(await jobsOf()).length}`);
  const r = await drain(T);
  check('OW-3e. el drenaje del outbox ni siquiera lee la cola (ownership_not_writable)',
    r?.drain?.skipped === 'ownership_not_writable' && (r?.drain?.claimed ?? 0) === 0, `skipped=${r?.drain?.skipped}`);
  // P_GONE nace SIN opt-in: es el producto que un dueño intentaría habilitar hoy.
  const { result: optin } = await call('metaCatalogSetSyncEnabled', owner, { productId: P_GONE, enabled: true });
  check('OW-3f. el opt-in queda BLOQUEADO con un mensaje claro (no promete una propagación imposible)',
    optin?.ok === false && optin?.ownershipBlocked === true && /fuente externa|feed/i.test(String(optin?.message ?? '')) && /origen/i.test(String(optin?.message ?? '')),
    `msg=${String(optin?.message ?? '').slice(0, 90)}`);
  check('OW-3g. y el producto NO quedó habilitado', (await productOf(P_GONE))?.syncToMeta !== true, `syncToMeta=${(await productOf(P_GONE))?.syncToMeta}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-4. hybrid campo por campo: el patch ajeno se rechaza, el propio pasa
// ═══════════════════════════════════════════════════════════════════════════
{
  // Odyssey sale del CICLO DE ESCRITURA a partir de acá: en el híbrido su precio sería nuestro
  // y encolaría un job en cada plan, lo que ensuciaría los contadores exactos de los envíos y
  // le pisaría el estado histórico que OW-7 verifica. Su opt-in se restituye antes de OW-17.
  await db.doc(`tenants/${T}/products/${P_ODYSSEY}`).set({ syncToMeta: false }, { merge: true });
  await setCfg(T, { ...CFG_LEGACY, mode: 'live', ownership: OWN_HIBRIDA });
  const p = await preview(owner);
  check('OW-4. hybrid ⇒ propiedad sana con la matriz EXPLÍCITA de los dos lados',
    p?.ownership?.degraded === false && p?.ownership?.model === 'hybrid' &&
    JSON.stringify(p.ownership.ownedFields) === JSON.stringify(['price', 'currency', 'availability', 'inventory']),
    `propios=${JSON.stringify(p?.ownership?.ownedFields)}`);
  const soloAjeno = entradaDe(p, P_HYBT);
  check('OW-4b. un producto donde SOLO difiere un campo ajeno (título) ⇒ bloqueado, jamás propuesto',
    soloAjeno?.action === 'blocked' && (soloAjeno?.blockedReasons ?? []).includes('externally_owned') && (soloAjeno?.notOwnedFields ?? []).includes('title'),
    `action=${soloAjeno?.action} ajenos=${JSON.stringify(soloAjeno?.notOwnedFields)}`);
  const mixto = entradaDe(p, P_HYB);
  check('OW-4c. con un campo PROPIO divergente el update sale, y lo ajeno se REPORTA (no se calla)',
    mixto?.action === 'update' && (mixto?.changedFields ?? []).includes('price') && (mixto?.notOwnedFields ?? []).length === 0,
    `action=${mixto?.action} cambia=${JSON.stringify(mixto?.changedFields)} ajenos=${JSON.stringify(mixto?.notOwnedFields)}`);
  const { res } = await aplicar(owner);
  const jobHyb = await jobDe(P_HYB);
  check('OW-4d. el apply encola SOLO el producto con cambio propio (el de campo ajeno no existe como job)',
    res?.status === 'queued' && !!jobHyb && (await jobDe(P_HYBT)) === null && !!jobHyb.ownershipFingerprint,
    `status=${res?.status} jobs=${(await jobsOf()).map((j) => j.productId).join(',')}`);
  const patch = jobHyb?.intendedPatch ?? {};
  check('OW-4e. el patch congelado lleva SOLO campos propios (id + price) y la foto de la propiedad',
    Object.keys(patch).sort().join(',') === 'id,price' && JSON.stringify(jobHyb?.ownedFields) === JSON.stringify(['price', 'currency', 'availability', 'inventory']),
    `patch=${Object.keys(patch).join(',')}`);
  // Un patch con un campo AJENO adentro no puede salir ni aunque alguien lo escriba a mano en
  // el job: el gate lo valida sobre las claves REALES, no sobre lo que el plan creyó mandar.
  await db.doc(`tenants/${T}/metaCatalogOutboxJobs/${jobHyb.id}`).set({ intendedPatch: { ...patch, title: 'Titulo que NO es nuestro' } }, { merge: true });
  await wipeWrites();
  const rAjeno = await drain(T);
  const jobTrasAjeno = await jobDe(P_HYB);
  check('OW-4f. un patch con UN campo ajeno adentro se RECHAZA antes del POST (needs_action, cero envíos)',
    jobTrasAjeno?.status === 'needs_action' && jobTrasAjeno?.reason === 'ownership_not_writable' && (await writesSnap()).empty,
    `status=${jobTrasAjeno?.status} reason=${jobTrasAjeno?.reason} enviados=${(await idsEnviados()).join(',')}`);
  check('OW-4f². el drenaje lo reporta como bloqueo de PROPIEDAD, no como "no había nada"',
    (rAjeno?.drain?.ownershipBlocked ?? 0) >= 1 && rAjeno?.drain?.skipped === 'ownership_not_writable', `skipped=${rAjeno?.drain?.skipped}`);
  // …y con el patch legítimo, el MISMO camino sí envía.
  await wipeCol(`tenants/${T}/metaCatalogOutboxJobs`);
  await wipeCol(`tenants/${T}/metaCatalogOutboxIntents`);
  await wipeWrites();
  await aplicar(owner);
  const rOk = await drain(T);
  const enviados = await idsEnviados();
  check('OW-4g. con campos PROPIOS el envío sale (un solo artículo, un solo campo público)',
    (rOk?.drain?.submitted ?? 0) === 1 && enviados.length === 1 && enviados[0] === P_HYB, `submitted=${rOk?.drain?.submitted} ids=${enviados.join(',')}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-5. Feed NUEVO / fingerprint CAMBIADO ⇒ bloqueo de escrituras + alerta idempotente
// OW-6. El secreto del feed jamás se persiste ni se loguea
// ═══════════════════════════════════════════════════════════════════════════
const limpiarCola = async () => {
  await wipeCol(`tenants/${T}/metaCatalogOutboxJobs`);
  await wipeCol(`tenants/${T}/metaCatalogOutboxIntents`);
  await wipeWrites();
  await db.doc(`tenants/${T}/products/${P_HYB}`).set({ price: 310000 + Math.floor(Math.random() * 1000) * 1000 }, { merge: true });
  await aplicar(owner);
};
{
  await wipeCol(`tenants/${T}/metaCatalogSourceChecks`);
  await deleteRefs((await db.collection(`tenants/${T}/notifications`).where('category', '==', 'catalog_source').get()).docs.map((d) => d.ref));
  // La fuente RECONOCIDA (la misma huella que declara `ownership.external`) publica el catálogo.
  await setFuentes([feedCrudo()], { feedCount: 1 });
  await limpiarCola();
  const rOk = await drain(T);
  const checksOk = await sourceChecks();
  check('OW-5. con la fuente RECONOCIDA el envío sale y la verificación queda registrada como sin_cambios',
    (rOk?.drain?.submitted ?? 0) === 1 && checksOk.length === 1 && checksOk[0].status === 'sin_cambios',
    `submitted=${rOk?.drain?.submitted} checks=${checksOk.map((c) => c.status).join(',')}`);
  check('OW-5b. sin hallazgo NO se fabrica ninguna alerta', (await notifsDe('catalog_source')).length === 0);

  // ── Aparece un feed que NADIE reconoció ──
  await setFuentes([feedCrudo(), feedNuevoCrudo()], { feedCount: 2 });
  await limpiarCola();
  const rNuevo = await drain(T);
  const enviados = await idsEnviados();
  check('OW-5c. feed NUEVO sin reconocer ⇒ el envío NO sale (external_source_changed, cero POST)',
    rNuevo?.drain?.skipped === 'external_source_changed' && enviados.length === 0 && (rNuevo?.drain?.submitted ?? 0) === 0,
    `skipped=${rNuevo?.drain?.skipped} enviados=${enviados.length}`);
  const jobTrasBloqueo = await jobDe(P_HYB);
  check('OW-5d. el job vuelve a la cola INTACTO (no es culpa suya: la fuente la decide una persona)',
    jobTrasBloqueo?.status === 'queued' && jobTrasBloqueo?.attentionRequired !== true, `status=${jobTrasBloqueo?.status}`);
  const alerta1 = await notifsDe('catalog_source');
  check('OW-5e. se abre UNA alerta agregada con el id del feed nuevo (jamás su URL)',
    alerta1.length === 1 && alerta1[0].status === 'fuente_nueva' && (alerta1[0].sourceIds ?? []).includes('ds-feed-2') && alerta1[0].read === false,
    `n=${alerta1.length} status=${alerta1[0]?.status} ids=${JSON.stringify(alerta1[0]?.sourceIds)}`);

  // ── El MISMO hallazgo repetido no vuelve a alertar ──
  const rRepetido = await drain(T);
  const alerta2 = await notifsDe('catalog_source');
  const checksRepetido = await sourceChecks();
  const conEsaHuella = checksRepetido.find((c) => c.id === alerta2[0]?.sourceCheckId);
  check('OW-5f. repetir el drenaje NO duplica la alerta: sigue habiendo UNA sola (idempotente)',
    rRepetido?.drain?.skipped === 'external_source_changed' && alerta2.length === 1 && alerta2[0].id === alerta1[0].id && alerta2[0].createdAt.toMillis() === alerta1[0].createdAt.toMillis(),
    `n=${alerta2.length}`);
  check('OW-5f². y la evidencia se AGREGA en el mismo doc de verificación (checkCount sube, no la colección)',
    checksRepetido.length === 2 && (conEsaHuella?.checkCount ?? 0) >= 2, `checks=${checksRepetido.length} count=${conEsaHuella?.checkCount}`);

  // ── La fuente reconocida cambia de FORMA (mismo id, otro horario) ──
  const feedCambiado = feedCrudo({ schedule: { interval: 'HOURLY', hour: '5', minute: '0', timezone: 'America/Asuncion', url: FEED_URL } });
  await setFuentes([feedCambiado], { feedCount: 1 });
  const rCambio = await drain(T);
  const checkCambio = (await sourceChecks()).find((c) => c.status === 'fingerprint_cambiado');
  check('OW-5g. la fuente reconocida cambia de forma ⇒ fingerprint_cambiado y las escrituras siguen frenadas',
    rCambio?.drain?.skipped === 'external_source_changed' && !!checkCambio && (checkCambio.changedSourceIds ?? []).includes('ds-feed-1') && (await idsEnviados()).length === 0,
    `skipped=${rCambio?.drain?.skipped} cambiados=${JSON.stringify(checkCambio?.changedSourceIds)}`);
  const alerta3 = await notifsDe('catalog_source');
  check('OW-5g². un hallazgo DISTINTO reabre la MISMA alerta agregada (nunca una segunda campana)',
    alerta3.length === 1 && alerta3[0].status === 'fingerprint_cambiado' && alerta3[0].sourceCheckId === checkCambio.id, `n=${alerta3.length} status=${alerta3[0]?.status}`);

  // ── Vuelve la fuente reconocida: el camino se rehabilita y la alerta se autocierra ──
  await setFuentes([feedCrudo()], { feedCount: 1 });
  const rVuelta = await drain(T);
  const alerta4 = await notifsDe('catalog_source');
  check('OW-5h. al volver la fuente reconocida el envío sale y la alerta se AUTOCIERRA (no se borra)',
    (rVuelta?.drain?.submitted ?? 0) === 1 && alerta4.length === 1 && alerta4[0].resolvedAt !== null && alerta4[0].read === true,
    `submitted=${rVuelta?.drain?.submitted} resolvedAt=${alerta4[0]?.resolvedAt ? 'sí' : 'no'}`);

  // ═══ OW-6. El secreto del feed jamás se persiste ni se loguea ═══
  const chequeados = await sourceChecks();
  const cuerpoChecks = JSON.stringify(chequeados);
  check('OW-6. el doc de sourceChecks guarda metadata SANEADA: host sin query, nombre sin URL, cero token',
    !cuerpoChecks.includes(FEED_TOKEN) && !cuerpoChecks.includes('access_token') && !cuerpoChecks.includes('OTRO-SECRETO') &&
    !/https?:\/\//.test(cuerpoChecks) && chequeados.every((c) => (c.sources ?? []).every((s) => s.host === 'tienda.e2e.test' || s.host === 'promos.e2e.test')),
    `hosts=${JSON.stringify([...new Set(chequeados.flatMap((c) => (c.sources ?? []).map((s) => s.host)))])}`);
  check('OW-6b. la HUELLA tampoco lo contiene (se calcula sobre datos no secretos) ni lo hace la config',
    chequeados.every((c) => !String(c.fingerprint ?? '').includes(FEED_TOKEN)) && !JSON.stringify(await cfgOf(T)).includes(FEED_TOKEN) &&
    !JSON.stringify(await notifsDe('catalog_source')).includes(FEED_TOKEN),
    `fingerprint=${String(chequeados[0]?.fingerprint ?? '').slice(0, 24)}…`);
  const rutaLog = process.env.E2E_EMULATOR_LOG ?? '';
  let logLimpio = false;
  let detalleLog = 'falta E2E_EMULATOR_LOG (exportá la ruta de la salida del emulador)';
  if (rutaLog) {
    try {
      const texto = readFileSync(rutaLog, 'utf8');
      // Se exige que el log tenga contenido REAL (si no, "no aparece" sería trivialmente cierto).
      logLimpio = texto.length > 1000 && !texto.includes(FEED_TOKEN) && !texto.includes('OTRO-SECRETO') && !texto.includes('access_token');
      detalleLog = `log=${texto.length} bytes`;
    } catch (e) {
      detalleLog = `no se pudo leer ${rutaLog}`;
    }
  }
  check('OW-6c. la salida del emulador tampoco menciona el token ni la query string del feed', logLimpio, detalleLog);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-11. El outbox revalida la PROPIEDAD antes del POST: un cambio durante el lease
//        impide el envío y jamás se reintenta con permisos viejos.
// ═══════════════════════════════════════════════════════════════════════════
const setHold = async (p) => {
  await db.doc(`tenants/${T}/_debug/catalogHolds`).delete().catch(() => {}); // testigo limpio
  await db.doc(`tenants/${T}/_debug/catalogFixtures`).set({ holdAt: p, resume: false });
};
const resumeHold = (p) => db.doc(`tenants/${T}/_debug/catalogFixtures`).set({ holdAt: p, resume: true });
const clearHold = () => db.doc(`tenants/${T}/_debug/catalogFixtures`).delete().catch(() => {});
const waitHold = async (p) => {
  for (let i = 0; i < 80; i++) {
    if ((await db.doc(`tenants/${T}/_debug/catalogHolds`).get()).data()?.point === p) return true;
    await sleep(250);
  }
  return false;
};
{
  await limpiarCola();
  const jobAntes = await jobDe(P_HYB);
  await setHold('outbox_pre_submit');
  const drenaje = drain(T);
  const llego = await waitHold('outbox_pre_submit');
  // La propiedad CAMBIA con el job ya reclamado: el dueño reclama `availability` para el feed.
  const OWN_HIBRIDA_2 = {
    model: 'hybrid', ownedFields: ['price', 'currency'],
    external: externaReconocida({ declaredFields: ['title', 'description', 'brand', 'category', 'image', 'url', 'availability', 'inventory'] }),
    lastSourceCheckAt: now,
  };
  await setCfg(T, { ...CFG_LEGACY, mode: 'live', ownership: OWN_HIBRIDA_2 });
  await resumeHold('outbox_pre_submit');
  const r = await drenaje;
  await clearHold();
  check('OW-11. la propiedad cambia DURANTE el lease ⇒ nada sale del lote (ownership_changed)',
    llego && r?.drain?.skipped === 'ownership_changed' && (r?.drain?.submitted ?? 0) === 0 && (await idsEnviados()).length === 0,
    `hold=${llego} skipped=${r?.drain?.skipped} enviados=${(await idsEnviados()).length}`);
  const r2 = await drain(T);
  const jobDespues = await jobDe(P_HYB);
  check('OW-11b. el reintento NO lo manda con permisos viejos: el job va a revisión con el motivo exacto',
    jobDespues?.status === 'needs_action' && jobDespues?.reason === 'ownership_changed' && jobDespues?.attentionRequired === true && (await idsEnviados()).length === 0,
    `status=${jobDespues?.status} reason=${jobDespues?.reason} enviados=${(await idsEnviados()).length}`);
  check('OW-11b². y la huella congelada del job es la VIEJA (por eso se lo pudo distinguir)',
    !!jobAntes?.ownershipFingerprint && jobDespues?.ownershipFingerprint === jobAntes.ownershipFingerprint && (r2?.drain?.submitted ?? 0) === 0,
    `submitted=${r2?.drain?.submitted}`);
  await setCfg(T, { ...CFG_LEGACY, mode: 'live', ownership: OWN_HIBRIDA });
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-12. Cero loops: con el catálogo gobernado por el feed, dos ciclos con el remoto
//        revertido no encolan un solo job.
// ═══════════════════════════════════════════════════════════════════════════
{
  await wipeCol(`tenants/${T}/metaCatalogOutboxJobs`);
  await wipeCol(`tenants/${T}/metaCatalogOutboxIntents`);
  await wipeWrites();
  await setCfg(T, { ...CFG_LEGACY, mode: 'live', ownership: OWN_EXTERNA });
  const ciclo = async () => {
    const { res, err } = await aplicar(owner);
    const r = await drain(T);
    return { apply: res?.status ?? null, err: err ?? null, jobs: (await jobsOf()).length, envios: (await idsEnviados()).length, drain: r?.drain?.skipped ?? null };
  };
  const c1 = await ciclo();
  // El feed "revierte" de madrugada: el remoto vuelve a decir lo que decía.
  await setFixture(ITEMS_BASE(), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  const c2 = await ciclo();
  // (ADR-0022 §4) La FORMA del bloqueo del apply cambió (gate de relación `mirror` ⇒
  // failed-precondition en vez del `apply_blocked` amable); la SUSTANCIA es la misma y se
  // sigue exigiendo entera: cero jobs, cero envíos, y el drenaje sin leer la cola. La
  // reconciliación/verificación del ciclo diario de arfagi siguen corriendo bajo mirror
  // (OW-7..10 y OW-17h lo prueban en este mismo script).
  check('OW-12. dos ciclos completos con el remoto revertido ⇒ CERO jobs y CERO escrituras (el loop diario es inalcanzable)',
    c1.jobs === 0 && c2.jobs === 0 && c1.envios === 0 && c2.envios === 0 &&
    c1.apply === null && c1.err === 'FAILED_PRECONDITION' && c2.apply === null && c2.err === 'FAILED_PRECONDITION' &&
    c1.drain === 'ownership_not_writable' && c2.drain === 'ownership_not_writable',
    `c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-7 a OW-10. Reconciliación: estado ACTUAL honesto (verified / drifted_external /
//               remote_missing / unverifiable) y `stale` DERIVADO por TTL.
// ═══════════════════════════════════════════════════════════════════════════
const verificar = async (token = owner, data = {}) => {
  let r = (await call('metaCatalogVerificationRun', token, data)).result;
  for (let i = 0; i < 8 && r?.more === true; i++) r = (await call('metaCatalogVerificationRun', token, {})).result;
  return r;
};
{
  const r = await verificar();
  check('OW-7(pre). el barrido completa las dos fases (remoto + faltantes) sin errores',
    r?.ok === true && r?.status === 'completed' && r?.phase === 'done' && (r?.counters?.errors ?? 1) === 0 && r?.missingDetectionSkipped === false,
    `status=${r?.status} phase=${r?.phase} counters=${JSON.stringify(r?.counters)}`);

  const ody = await productOf(P_ODYSSEY);
  check('OW-7. producto VINCULADO A MANO con precio gobernado por el feed (250.000 local / 130.000 remoto) ⇒ drifted_external',
    ody?.metaSyncState === 'drifted_external' && (ody?.metaDrift?.fields ?? []).includes('price') && ody?.metaDrift?.owner === 'external' && ody?.metaDrift?.severity === 'commercial',
    `state=${ody?.metaSyncState} campos=${JSON.stringify(ody?.metaDrift?.fields)} dueño=${ody?.metaDrift?.owner}`);
  const obsPrecio = (ody?.metaDrift?.observed ?? []).find((o) => o.field === 'price');
  check('OW-7b. la deriva guarda los valores OBSERVADOS saneados y el id NO secreto de la fuente',
    obsPrecio?.local === '250000 PYG' && /130\.?000/.test(String(obsPrecio?.remote ?? '')) && ody?.metaDrift?.externalSourceId === 'ds-feed-1',
    `local=${obsPrecio?.local} remoto=${obsPrecio?.remote} fuente=${ody?.metaDrift?.externalSourceId}`);
  check('OW-7c. el eje HISTÓRICO queda intacto: metaSyncStatus y metaLastSyncAt no se tocan',
    ody?.metaSyncStatus === 'synced' && !!ody?.metaLastSyncAt && !!ody?.metaVerifiedAt && ody.metaVerifiedAt.toMillis() > ody.metaLastSyncAt.toMillis(),
    `status=${ody?.metaSyncStatus}`);
  check('OW-7d. y el precio LOCAL no se pisó con el remoto (la corrección va EN EL ORIGEN del feed)', ody?.price === 250000, `precio=${ody?.price}`);

  const verif = await productOf(P_VERIF);
  check('OW-9(pre). un artículo que coincide campo por campo queda verified con su fecha de LECTURA',
    verif?.metaSyncState === 'verified' && !!verif?.metaVerifiedAt && (verif?.metaDrift ?? null) === null, `state=${verif?.metaSyncState}`);

  const gone = await productOf(P_GONE);
  check('OW-9. el artículo que el feed borró ⇒ remote_missing (y el producto local NO se borra)',
    gone?.metaSyncState === 'remote_missing' && !!gone?.metaVerifiedAt && gone?.metaRetailerId === P_GONE, `state=${gone?.metaSyncState}`);

  const otro = await productOf(P_OTRO);
  check('OW-10. vinculado a OTRO catálogo (no lo leímos) ⇒ unverifiable, jamás "no existe"',
    otro?.metaSyncState === 'unverifiable' && !otro?.metaVerifiedAt, `state=${otro?.metaSyncState} verifiedAt=${otro?.metaVerifiedAt ? 'sí' : 'no'}`);
  const local = await productOf(P_LOCAL);
  check('OW-10b. un producto SIN identidad remota no recibe estado (no hay nada que verificar)',
    (local?.metaSyncState ?? null) === null, `state=${local?.metaSyncState}`);

  // `stale` DERIVADO en lectura por la proyección REAL (nunca se persiste).
  const { metaDriftProjection } = await import(new URL('../lib/meta/catalogDriftProjection.js', import.meta.url).href);
  const fresco = (await metaDriftProjection.snapshots(T, [P_VERIF]))[0];
  await db.doc(`tenants/${T}/products/${P_VERIF}`).set({ metaVerifiedAt: Timestamp.fromMillis(Date.now() - 48 * 3600_000) }, { merge: true });
  const viejo = (await metaDriftProjection.snapshots(T, [P_VERIF]))[0];
  const persistido = await productOf(P_VERIF);
  check('OW-10c. con la lectura vencida el estado EFECTIVO es stale, y `stale` jamás se persiste',
    fresco?.state === 'verified' && viejo?.state === 'stale' && persistido?.metaSyncState === 'verified',
    `fresco=${fresco?.state} vencido=${viejo?.state} persistido=${persistido?.metaSyncState}`);

  // ═══ OW-8. Un job succeeded seguido de un cambio remoto: el estado ACTUAL deja de ser verified ═══
  await db.doc(`tenants/${T}/products/${P_VERIF}`).set({ metaVerifiedAt: persistido.metaVerifiedAt }, { merge: true });
  const jobHistorico = db.doc(`tenants/${T}/metaCatalogOutboxJobs/own-historico-1`);
  await jobHistorico.set({
    id: 'own-historico-1', tenantId: T, catalogId: CATALOG_ID, productId: P_VERIF, retailerId: P_VERIF,
    action: 'update', status: 'succeeded', reason: null, attentionRequired: false, attempts: 1,
    intendedPatch: { id: P_VERIF, price: '250000 PYG' }, intendedContentHash: 'own-hist', ownershipFingerprint: 'own-hist',
    ownedFields: ['price'], productSnapshotHash: 'own-hist', runId: 'own-hist', createdAt: now, updatedAt: now,
  });
  // El feed cambia el artículo DESPUÉS de nuestra escritura confirmada.
  await setFixture(ITEMS_BASE().map((i) => (i.retailer_id === P_VERIF ? { ...i, price: '₲190.000' } : i)), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  await verificar();
  const trasCambio = await productOf(P_VERIF);
  const jobTras = (await jobHistorico.get()).data();
  check('OW-8. un job succeeded NO inmuniza al producto: tras el cambio remoto el estado ACTUAL deja de ser verified',
    jobTras?.status === 'succeeded' && trasCambio?.metaSyncState === 'drifted_external' && (trasCambio?.metaDrift?.fields ?? []).includes('price'),
    `job=${jobTras?.status} state=${trasCambio?.metaSyncState}`);
  await jobHistorico.delete();

  // Idempotencia del incidente: re-verificar la MISMA deriva conserva su `detectedAt`.
  const detectadoAntes = trasCambio.metaDrift.detectedAt.toMillis();
  await sleep(50);
  const r2 = await verificar();
  const trasSegunda = await productOf(P_VERIF);
  check('OW-8b. re-verificar la MISMA deriva no la re-fecha (mismo incidente, no uno nuevo por día)',
    trasSegunda?.metaDrift?.detectedAt?.toMillis() === detectadoAntes && (r2?.counters?.unchanged ?? 0) > 0,
    `detectedAt igual=${trasSegunda?.metaDrift?.detectedAt?.toMillis() === detectadoAntes} unchanged=${r2?.counters?.unchanged}`);
  check('OW-8c. la reconciliación NO escribió NADA en Meta (solo lee)', (await writesSnap()).empty);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-13. Bot y checkout fail-closed ante deriva crítica: handoff idempotente, sin orden;
//        tras reconciliar (los dos lados iguales) el camino se rehabilita.
// ═══════════════════════════════════════════════════════════════════════════
const [C_BOT, C_CHECKOUT, C_SANO] = CLIENTES;
{
  const notifsHandoffDe = async (cid) => (await db.collection(`tenants/${T}/notifications`).where('category', '==', 'handoff').get())
    .docs.map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.customerId === cid);

  // ── (a) El bot NO cotiza un producto con deriva comercial: deriva a una persona ──
  await bot(`+${C_BOT}`, 'hola');
  const rBot = await bot(`+${C_BOT}`, 'quiero el Odyssey Ownership');
  const sesBot = await sessionOf(C_BOT);
  const nBot = await notifsHandoffDe(C_BOT);
  check('OW-13. el bot NO afirma precio ni stock de un producto en deriva: deriva a una persona',
    /confirmar/i.test(String(rBot?.reply ?? '')) && sesBot?.context?.humanTakeover === true && sesBot?.context?.handoffReason === 'catalog_drift',
    `takeover=${sesBot?.context?.humanTakeover} razón=${sesBot?.context?.handoffReason}`);
  check('OW-13b. el mensaje al cliente no menciona el precio en disputa, ni el feed, ni Meta',
    !/130|250\.000|250000|feed|Meta/i.test(String(rBot?.reply ?? '')), `reply=${String(rBot?.reply ?? '').slice(0, 90)}`);
  check('OW-13c. UNA sola notificación de handoff con la razón estructurada catalog_drift',
    nBot.length === 1 && nBot[0].type === 'handoff_catalog_drift', `n=${nBot.length} type=${nBot[0]?.type}`);
  await bot(`+${C_BOT}`, 'sigue disponible?');
  check('OW-13d. un segundo turno NO genera un segundo aviso (idempotente por la deriva)', (await notifsHandoffDe(C_BOT)).length === 1);
  check('OW-13e. y no se creó ninguna orden', (await ordersDe(C_BOT)).length === 0);

  // ── (b) El checkout tampoco: el carrito se armó ANTES de que el feed divergiera ──
  await db.doc(`tenants/${T}/customers/${C_CHECKOUT}`).set({ id: C_CHECKOUT, tenantId: T, phone: `+${C_CHECKOUT}`, name: 'Cliente Checkout', createdAt: now, updatedAt: now }, { merge: true });
  await db.doc(`tenants/${T}/customers/${C_CHECKOUT}/sessions/active`).set({
    id: 'active', tenantId: T, customerId: C_CHECKOUT, state: 'CART',
    cart: { items: [{ productId: P_ODYSSEY, name: 'Odyssey Ownership', price: 250000, quantity: 1, imageUrl: IMG(P_ODYSSEY) }], subtotal: 250000 },
    context: { lastMessageAt: Timestamp.now(), currentPage: 1, currentCategoryId: null, pendingOrderId: null, pendingPaymentId: null, lastShownSkus: [], humanTakeover: false, pendingCartConfirmation: null },
    expiresAt: Timestamp.fromMillis(Date.now() + 86400_000), updatedAt: Timestamp.now(),
  });
  const rPago = await bot(`+${C_CHECKOUT}`, 'quiero pagar');
  const sesPago = await sessionOf(C_CHECKOUT);
  check('OW-13f. el CHECKOUT no crea la orden con un producto en deriva y deriva a una persona',
    (await ordersDe(C_CHECKOUT)).length === 0 && sesPago?.context?.humanTakeover === true && sesPago?.context?.handoffReason === 'catalog_drift',
    `órdenes=${(await ordersDe(C_CHECKOUT)).length} takeover=${sesPago?.context?.humanTakeover}`);
  check('OW-13g. y jamás se mandan datos bancarios ni un total confirmado',
    !/transferencia|cuenta|banco|alias|ci:/i.test(String(rPago?.reply ?? '')) && (await notifsHandoffDe(C_CHECKOUT)).length === 1,
    `reply=${String(rPago?.reply ?? '').slice(0, 90)}`);
  check('OW-13h. el carrito se CONSERVA (nadie pierde lo que ya eligió)',
    (sesPago?.cart?.items ?? []).length === 1 && sesPago.cart.items[0].productId === P_ODYSSEY);

  // ── (c) Divergencia COSMÉTICA: no corta la conversación ──
  const nAntesCosmetica = (await db.collection(`tenants/${T}/notifications`).where('category', '==', 'handoff').get()).size;
  const rCosmetico = await bot(`+${C_SANO}`, 'tenes el Hibrido Solo Titulo Ownership?');
  const sesCosmetico = await sessionOf(C_SANO);
  check('OW-13i. una divergencia COSMÉTICA (solo el título) no corta la conversación ni deriva',
    !!rCosmetico?.reply && sesCosmetico?.context?.humanTakeover !== true &&
    (await db.collection(`tenants/${T}/notifications`).where('category', '==', 'handoff').get()).size === nAntesCosmetica,
    `takeover=${sesCosmetico?.context?.humanTakeover}`);

  // ── (d) Reconciliado en el ORIGEN: los dos lados dicen lo mismo ⇒ el camino se rehabilita ──
  await setFixture(ITEMS_BASE().map((i) => (i.retailer_id === P_ODYSSEY ? { ...i, price: '₲250.000' } : i)), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  await verificar();
  const odyOk = await productOf(P_ODYSSEY);
  check('OW-13j. corregido EN EL ORIGEN (feed a ₲250.000), la reconciliación lo declara verified',
    odyOk?.metaSyncState === 'verified' && (odyOk?.metaDrift ?? null) === null, `state=${odyOk?.metaSyncState}`);
  // Cliente NUEVO (el anterior quedó en atención humana, y eso no se deshace solo).
  const C_REHAB = CLIENTES[3];
  await bot(`+${C_REHAB}`, 'hola');
  const rRehab = await bot(`+${C_REHAB}`, 'quiero el Odyssey Ownership');
  const sesRehab = await sessionOf(C_REHAB);
  check('OW-13k. con los dos lados iguales el bot vuelve a atender (sin takeover ni deriva)',
    !!rRehab?.reply && sesRehab?.context?.humanTakeover !== true && sesRehab?.context?.handoffReason !== 'catalog_drift',
    `takeover=${sesRehab?.context?.humanTakeover} reply=${String(rRehab?.reply ?? '').slice(0, 60)}`);
  await db.doc(`tenants/${T}/customers/${C_REHAB}/sessions/active`).set({
    state: 'CART', cart: { items: [{ productId: P_ODYSSEY, name: 'Odyssey Ownership', price: 250000, quantity: 1, imageUrl: IMG(P_ODYSSEY) }], subtotal: 250000 },
  }, { merge: true });
  await bot(`+${C_REHAB}`, 'quiero pagar');
  check('OW-13l. y el checkout vuelve a crear la orden (el freno era la deriva, no una regla nueva)',
    (await ordersDe(C_REHAB)).length === 1, `órdenes=${(await ordersDe(C_REHAB)).length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-14. Aislamiento cross-tenant
// ═══════════════════════════════════════════════════════════════════════════
{
  await setCfg(T2, { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, ownership: OWN_EXTERNA });
  const odyAntes = await productOf(P_ODYSSEY);
  const { result: rAjeno } = await call('metaCatalogVerificationRun', ownerBoutique, { tenantId: T });
  const corridasT2 = await db.collection(`tenants/${T2}/metaCatalogVerificationRuns`).get();
  const corridasT = await db.collection(`tenants/${T}/metaCatalogVerificationRuns`).get();
  const odyDespues = await productOf(P_ODYSSEY);
  check('OW-14. un OWNER ajeno pidiendo otro tenant corre sobre EL SUYO (los claims mandan)',
    rAjeno?.ok === true && corridasT2.size === 1 && corridasT2.docs[0].data().tenantId === T2, `runsT2=${corridasT2.size}`);
  check('OW-14b. el tenant original no recibió NI UNA corrida nueva ni un producto tocado',
    corridasT.docs.every((d) => d.data().tenantId === T) && JSON.stringify(odyAntes) === JSON.stringify(odyDespues));
  const { result: migAjena } = await call('metaCatalogOwnershipMigrationRun', ownerBoutique, { tenantId: T });
  check('OW-14c. lo mismo con la migración de propiedad: el plan es del tenant del que reclama',
    migAjena?.ok === true && migAjena?.plan?.tenantId === T2, `plan=${migAjena?.plan?.tenantId}`);
  const runsMigT = await db.collection(`tenants/${T}/metaCatalogOwnershipRuns`).get();
  check('OW-14d. y no se creó ninguna corrida de migración bajo el tenant ajeno', runsMigT.empty, `runs=${runsMigT.size}`);
  const checksT2 = await sourceChecks(T2);
  check('OW-14e. las verificaciones de fuentes viven bajo SU tenant (nunca cruzan de carpeta)',
    checksT2.every((c) => !!c.fingerprint) && (await sourceChecks(T)).every((c) => !!c.fingerprint));
  await wipeCol(`tenants/${T2}/metaCatalogVerificationRuns`);
  await wipeCol(`tenants/${T2}/metaCatalogOwnershipRuns`);
  await db.doc(`tenants/${T2}/config/meta`).delete().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-15. Roles owner / manager / seller sobre los callables nuevos
// ═══════════════════════════════════════════════════════════════════════════
{
  const { err: eSellerV } = await call('metaCatalogVerificationRun', seller, {});
  const { err: eManagerV } = await call('metaCatalogVerificationRun', manager, {});
  check('OW-15. correr la reconciliación es OWNER-only (seller y manager denegados)',
    eSellerV === 'PERMISSION_DENIED' && eManagerV === 'PERMISSION_DENIED', `seller=${eSellerV} manager=${eManagerV}`);
  const { result: stManager } = await call('metaCatalogVerificationStatus', manager, {});
  const { err: eSellerSt } = await call('metaCatalogVerificationStatus', seller, {});
  check('OW-15b. leer el estado de la reconciliación es manager+ (el seller no)',
    stManager?.ok === true && eSellerSt === 'PERMISSION_DENIED', `manager=${stManager?.ok} seller=${eSellerSt}`);
  const { err: eSellerM } = await call('metaCatalogOwnershipMigrationRun', seller, {});
  const { err: eManagerM } = await call('metaCatalogOwnershipMigrationRun', manager, {});
  check('OW-15c. la migración de propiedad es OWNER-only (es una decisión de gobierno)',
    eSellerM === 'PERMISSION_DENIED' && eManagerM === 'PERMISSION_DENIED', `seller=${eSellerM} manager=${eManagerM}`);
  const { err: eManagerMSt } = await call('metaCatalogOwnershipMigrationStatus', manager, { runId: 'inexistente' });
  check('OW-15d. y su estado también: ni el MANAGER lee quién gobierna el catálogo', eManagerMSt === 'PERMISSION_DENIED', `manager=${eManagerMSt}`);
  const { err: eAdminV } = await call('metaCatalogVerificationRun', admin, {});
  const { err: eAdminM } = await call('metaCatalogOwnershipMigrationRun', admin, {});
  check('OW-15e. PLATFORM_ADMIN sin tenant explícito ⇒ invalid-argument (jamás un default)',
    eAdminV === 'INVALID_ARGUMENT' && eAdminM === 'INVALID_ARGUMENT', `v=${eAdminV} m=${eAdminM}`);
  check('OW-15f. las corridas y las verificaciones de fuente están CERRADAS al cliente por rules',
    (await restGet(`tenants/${T}/metaCatalogVerificationRuns/x`, owner)) === 403 &&
    (await restGet(`tenants/${T}/metaCatalogOwnershipRuns/x`, owner)) === 403 &&
    (await restGet(`tenants/${T}/metaCatalogSourceChecks/x`, owner)) === 403);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-16. credipower INTACTO: sin config de catálogo, nada ocurre (fail-closed nivel 1)
// ═══════════════════════════════════════════════════════════════════════════
{
  const { err: eVerif, errMsg } = await call('metaCatalogVerificationRun', admin, { tenantId: T3 });
  check('OW-16. reconciliar un tenant SIN config de catálogo ⇒ failed-precondition (ni una llamada)',
    eVerif === 'FAILED_PRECONDITION' && /no está configurada/i.test(String(errMsg ?? '')), `err=${eVerif}`);
  const { result: mig } = await call('metaCatalogOwnershipMigrationRun', admin, { tenantId: T3 });
  check('OW-16b. la migración lo reporta como sync_disabled y NO propone ni escribe nada',
    mig?.ok === true && (mig?.plan?.blockers ?? []).includes('sync_disabled') && mig?.plan?.proposedModel === null && mig?.ownershipWritten === false,
    `blockers=${JSON.stringify(mig?.plan?.blockers)}`);
  const { err: eApply } = await call('metaCatalogOwnershipMigrationRun', admin, { tenantId: T3, mode: 'apply', confirm: true });
  check('OW-16c. y un apply sobre él queda bloqueado antes de tocar un solo documento', eApply === 'FAILED_PRECONDITION', `err=${eApply}`);
  const cfgT3 = await db.doc(`tenants/${T3}/config/meta`).get();
  const checksT3 = await sourceChecks(T3);
  const prodsT3 = await db.collection(`tenants/${T3}/products`).get();
  check('OW-16d. credipower sigue SIN config, sin verificaciones de fuente y sin productos tocados',
    !cfgT3.exists && checksT3.length === 0 && prodsT3.empty, `cfg=${cfgT3.exists} checks=${checksT3.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-17. Migración preview/apply: el preview no escribe, el apply exige confirm, es
//        idempotente y deja a "arfagi" en external_managed con Odyssey drifted_external.
// ═══════════════════════════════════════════════════════════════════════════
{
  // Punto de partida REAL: el documento legacy de producción + el feed publicando el catálogo.
  await setCfg(T, CFG_LEGACY);
  await setFixture(ITEMS_BASE(), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  await wipeCol(`tenants/${T}/metaCatalogOwnershipRuns`);
  // Odyssey vuelve a tener su opt-in (así estaba en producción: el único producto habilitado):
  // la migración NO puede tocarlo, y OW-17f² lo verifica.
  await db.doc(`tenants/${T}/products/${P_ODYSSEY}`).set({ syncToMeta: true }, { merge: true });
  for (const id of [P_ODYSSEY, P_VERIF, P_GONE, P_OTRO, P_HYB, P_HYBT]) {
    await db.doc(`tenants/${T}/products/${id}`).set({ metaSyncState: FieldValue.delete(), metaVerifiedAt: FieldValue.delete(), metaDrift: FieldValue.delete() }, { merge: true });
  }
  const cfgAntes = await db.doc(`tenants/${T}/config/meta`).get();
  const prodsAntes = new Map((await db.collection(`tenants/${T}/products`).get()).docs.map((d) => [d.id, d.updateTime.toMillis()]));

  const { result: prev } = await call('metaCatalogOwnershipMigrationRun', owner, {});
  check('OW-17. el preview es el DEFAULT y propone external_managed con el feed DETECTADO (no declarado a mano)',
    prev?.ok === true && prev?.mode === 'preview' && prev?.status === 'completed' && prev?.plan?.proposedModel === 'external_managed' &&
    prev?.plan?.detectionAvailable === true && (prev?.plan?.detectedSources ?? []).length === 1 && (prev?.plan?.blockers ?? []).length === 0,
    `modelo=${prev?.plan?.proposedModel} fuentes=${(prev?.plan?.detectedSources ?? []).length} bloqueos=${JSON.stringify(prev?.plan?.blockers)}`);
  check('OW-17b. el preview anticipa el techo: el modo efectivo pasaría a dry_run aunque la config diga live',
    prev?.plan?.configMode === 'live' && prev?.plan?.effectiveModeAfter === 'dry_run' &&
    // Ídem OW-3: bajo `external_managed` la partición externa efectiva son todos los públicos.
    JSON.stringify(prev?.plan?.proposedExternalFields) === JSON.stringify(CAMPOS_PUBLICOS),
    `efectivo=${prev?.plan?.effectiveModeAfter} externos=${JSON.stringify(prev?.plan?.proposedExternalFields)}`);
  const cfgTrasPreview = await db.doc(`tenants/${T}/config/meta`).get();
  const prodsTrasPreview = new Map((await db.collection(`tenants/${T}/products`).get()).docs.map((d) => [d.id, d.updateTime.toMillis()]));
  check('OW-17c. el preview NO escribió NADA: config y productos byte-idénticos, cero estados sembrados',
    cfgTrasPreview.updateTime.toMillis() === cfgAntes.updateTime.toMillis() &&
    [...prodsAntes].every(([id, t]) => prodsTrasPreview.get(id) === t) && prev?.ownershipWritten === false &&
    (prev?.counters?.estadoSembrado ?? 0) > 0,
    `sembraría=${prev?.counters?.estadoSembrado}`);
  check('OW-17c². …y cuenta los "synced" que nadie verificó nunca (el verde falso de la auditoría)',
    (prev?.counters?.syncedNoVerificados ?? 0) >= 5 && (prev?.porEstado?.unverifiable ?? 0) === prev?.counters?.estadoSembrado,
    `synced=${prev?.counters?.syncedNoVerificados} porEstado=${JSON.stringify(prev?.porEstado)}`);

  const { err: sinConfirm } = await call('metaCatalogOwnershipMigrationRun', owner, { mode: 'apply' });
  check('OW-17d. el apply SIN confirm:true ⇒ failed-precondition (la confirmación jamás es implícita)', sinConfirm === 'FAILED_PRECONDITION', `err=${sinConfirm}`);

  const { result: apply } = await call('metaCatalogOwnershipMigrationRun', owner, { mode: 'apply', confirm: true });
  const cfgFinal = await cfgOf(T);
  check('OW-17e. el apply escribe la propiedad: external_managed con el feed reconocido y su huella SANEADA',
    apply?.ok === true && apply?.status === 'completed' && apply?.ownershipWritten === true &&
    cfgFinal?.ownership?.model === 'external_managed' && JSON.stringify(cfgFinal?.ownership?.ownedFields) === '[]' &&
    JSON.stringify(cfgFinal?.ownership?.external?.acknowledgedSourceIds) === JSON.stringify(['ds-feed-1']) &&
    cfgFinal?.ownership?.external?.fingerprint === HUELLA_FEED,
    `model=${cfgFinal?.ownership?.model} huella=${String(cfgFinal?.ownership?.external?.fingerprint ?? '').slice(0, 16)}…`);
  check('OW-17e². el resto de la config sobrevive intacto (jamás se reemplaza el mapa catalogSync entero)',
    cfgFinal?.enabled === true && cfgFinal?.mode === 'live' && cfgFinal?.catalogId === CATALOG_ID && cfgFinal?.sourceOfTruth === 'vendeyapy',
    `enabled=${cfgFinal?.enabled} mode=${cfgFinal?.mode} catalogId=${cfgFinal?.catalogId}`);
  check('OW-17e³. y el reconocimiento queda SELLADO con quién y cuándo',
    !!cfgFinal?.ownership?.external?.acknowledgedByUid && !!cfgFinal?.ownership?.external?.acknowledgedAt,
    `uid=${String(cfgFinal?.ownership?.external?.acknowledgedByUid ?? '').slice(0, 8)}…`);
  const odySembrado = await productOf(P_ODYSSEY);
  const localSembrado = await productOf(P_LOCAL);
  check('OW-17f. los productos con identidad remota reciben el estado HONESTO (unverifiable: no leímos Meta)',
    odySembrado?.metaSyncState === 'unverifiable' && odySembrado?.metaSyncStatus === 'synced' && (localSembrado?.metaSyncState ?? null) === null,
    `odyssey=${odySembrado?.metaSyncState} local=${localSembrado?.metaSyncState}`);
  check('OW-17f². y no se tocó un solo campo comercial (nombre, precio, stock, mapping, opt-in)',
    odySembrado?.price === 250000 && odySembrado?.name === 'Odyssey Ownership' && odySembrado?.inventory?.stock === 5 &&
    odySembrado?.metaRetailerId === P_ODYSSEY && odySembrado?.syncToMeta === true);

  const { result: apply2 } = await call('metaCatalogOwnershipMigrationRun', owner, { mode: 'apply', confirm: true });
  const cfgTras2 = await cfgOf(T);
  check('OW-17g. re-aplicar es IDEMPOTENTE: nada nuevo se siembra y la declaración no se re-sella',
    apply2?.ok === true && (apply2?.counters?.estadoSembrado ?? 1) === 0 && (apply2?.counters?.estadoVigente ?? 0) > 0 &&
    cfgTras2?.ownership?.external?.acknowledgedAt?.toMillis?.() === cfgFinal?.ownership?.external?.acknowledgedAt?.toMillis?.(),
    `sembrados=${apply2?.counters?.estadoSembrado} vigentes=${apply2?.counters?.estadoVigente}`);

  // El desenlace del ADR: arfagi en external_managed, con Odyssey en drifted_external.
  const r = await verificar();
  const odyFinal = await productOf(P_ODYSSEY);
  check('OW-17h. tras migrar, la reconciliación deja a Odyssey en drifted_external (local 250.000 / remoto 130.000)',
    r?.status === 'completed' && odyFinal?.metaSyncState === 'drifted_external' && (odyFinal?.metaDrift?.fields ?? []).includes('price') &&
    odyFinal?.metaDrift?.owner === 'external',
    `state=${odyFinal?.metaSyncState} campos=${JSON.stringify(odyFinal?.metaDrift?.fields)}`);
  // (ADR-0022 §4) Tras la migración a external_managed la relación deriva `mirror`: el apply
  // se rechaza en el gate de relación. Igual de cerrado que antes: cero jobs, cero POST.
  const { res: applyCatalogo, err: errApplyCat } = await aplicar(owner);
  check('OW-17i. y el catálogo ya no puede escribirse: apply rechazado (mirror), cero jobs, cero POST a Meta',
    applyCatalogo === null && errApplyCat === 'FAILED_PRECONDITION' &&
    (await jobsOf()).length === 0 && (await writesSnap()).empty,
    `err=${errApplyCat}`);
  check('OW-17j. el run de migración quedó AUDITADO y su doc cerrado al cliente',
    (await db.collection(`tenants/${T}/auditLogs`).where('action', '==', 'meta.catalog_ownership_migration_run').get()).size >= 3 &&
    (await restGet(`tenants/${T}/metaCatalogOwnershipRuns/${apply?.runId}`, owner)) === 403);
  const cuerpoRuns = JSON.stringify((await db.collection(`tenants/${T}/metaCatalogOwnershipRuns`).get()).docs.map((d) => d.data()));
  check('OW-17k. ni el run ni el plan persistido arrastran la URL firmada del feed',
    !cuerpoRuns.includes(FEED_TOKEN) && !cuerpoRuns.includes('access_token') && !/https?:\/\//.test(cuerpoRuns));
}

// ═══════════════════════════════════════════════════════════════════════════
// Herramientas de los escenarios de conversación/checkout (OW-18 y OW-19)
// ═══════════════════════════════════════════════════════════════════════════
/** Sesión NUEVA sembrada a mano (cliente incluido): el turno arranca sin takeover. */
async function sembrarSesion(cid, { estado, cart, pendingOrderId = null, tenant = T }) {
  await db.doc(`tenants/${tenant}/customers/${cid}`).set(
    { id: cid, tenantId: tenant, phone: `+${cid}`, name: `Cliente ${cid.slice(-4)}`, createdAt: now, updatedAt: now },
    { merge: true },
  );
  await db.doc(`tenants/${tenant}/customers/${cid}/sessions/active`).set({
    id: 'active', tenantId: tenant, customerId: cid, state: estado, cart,
    context: {
      lastMessageAt: Timestamp.now(), currentPage: 1, currentCategoryId: null, pendingOrderId,
      pendingPaymentId: null, lastShownSkus: [], humanTakeover: false, pendingCartConfirmation: null,
    },
    expiresAt: Timestamp.fromMillis(Date.now() + 86400_000), updatedAt: Timestamp.now(),
  });
}
const CARRITO_ODY = () => ({ items: [{ productId: P_ODYSSEY, name: 'Odyssey Ownership', price: 250000, quantity: 1, imageUrl: IMG(P_ODYSSEY) }], subtotal: 250000 });
const ITEM_ODY = (over = {}) => ({ itemId: 'it-ody-1', productId: P_ODYSSEY, productName: 'Odyssey Ownership', quantity: 1, unitPrice: 250000, subtotal: 250000, ...over });
/** Orden ABIERTA (PENDING_PAYMENT): es lo que la rama de reuso del checkout reenvía. */
async function sembrarOrden(id, cid, items, total, status = 'PENDING_PAYMENT') {
  await db.doc(`tenants/${T}/orders/${id}`).set({
    id, tenantId: T, customerId: cid, status, items,
    totals: { subtotal: total, discount: 0, shipping: 0, total },
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
}
const ordenDoc = (id) => db.doc(`tenants/${T}/orders/${id}`).get();
const notifsHandoffDeCliente = async (cid) =>
  (await db.collection(`tenants/${T}/notifications`).where('category', '==', 'handoff').get()).docs
    .map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.customerId === cid);
/**
 * Falla INYECTADA en la lectura de la proyección de deriva (hook solo-emulador). Es la única
 * forma de probar de punta a punta la diferencia entre "leí y no hay deriva" y "NO PUDE leer si
 * la hay": devolver lista vacía prueba justo lo contrario. `null` la retira.
 */
const inyectarFalla = (punto, tenant = T) =>
  punto
    ? db.doc(`tenants/${tenant}/_debug/driftFixtures`).set({ failAt: punto })
    : db.doc(`tenants/${tenant}/_debug/driftFixtures`).delete().catch(() => {});

// La razón ESTRUCTURADA del veredicto (unverifiable vs drifted_external) no se persiste en ningún
// documento —a propósito: lo que ve el cliente no la menciona— así que la única ventana honesta es
// la traza del emulador. Misma variable que ya exige OW-6c.
const RUTA_LOG = process.env.E2E_EMULATOR_LOG ?? '';
const tamañoLog = () => { try { return readFileSync(RUTA_LOG, 'utf8').length; } catch { return 0; } };
const logDesde = (desde) => { try { return readFileSync(RUTA_LOG, 'utf8').slice(desde); } catch { return ''; } };
/** ¿La traza muestra ESE frame y, dentro de su contexto, ESE dato? */
const trazaCon = (texto, frame, dato) => {
  const i = texto.indexOf(frame);
  return i >= 0 && texto.slice(i, i + 900).includes(dato);
};

const MENSAJES_MIXTOS = ['quiero pagar mi pedido', 'pagar, qué llevo?', 'quiero comprar, mostrame mi carrito', 'dale pago mi compra'];
/** Cualquier precio con separador de miles: ni 250.000 (local) ni 130.000 (el del feed). */
const MIL = /\d{3}\.\d{3}/;
const BANCO = /transferencia|cuenta:|banco|titular|alias|ci\/ruc/i;
const MSG_DERIVA = /Antes de avanzar (prefiero confirmarte|necesito confirmar) el precio y la disponibilidad de/;

// ═══════════════════════════════════════════════════════════════════════════
// OW-18. INTERSECCIÓN "pagar" ∧ "ver carrito": el turno termina en la VISTA DE CARRITO
//        (detalle por ítem + total), no en el checkout. Con el producto en deriva no
//        se cotiza nada y se deriva — en CART y también con el pago ya pedido.
// ═══════════════════════════════════════════════════════════════════════════
{
  await setCfg(T, { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, ownership: OWN_EXTERNA });
  await setFixture(ITEMS_BASE(), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  await verificar();
  const odyPre = await productOf(P_ODYSSEY);
  check('OW-18(pre). el escenario del owner: Odyssey drifted_external por PRECIO, con evidencia FRESCA',
    odyPre?.metaSyncState === 'drifted_external' && (odyPre?.metaDrift?.fields ?? []).includes('price') &&
    Date.now() - (odyPre?.metaVerifiedAt?.toMillis?.() ?? 0) < 3600_000,
    `state=${odyPre?.metaSyncState} campos=${JSON.stringify(odyPre?.metaDrift?.fields)}`);

  const corridas = { CART: [], AWAITING_PAYMENT: [] };
  for (const [i, texto] of MENSAJES_MIXTOS.entries()) {
    for (const estado of ['CART', 'AWAITING_PAYMENT']) {
      const cid = estado === 'CART' ? CLIENTES[4 + i] : CLIENTES[8 + i];
      const ordenId = estado === 'AWAITING_PAYMENT' ? `ord-a1-${cid.slice(-4)}` : null;
      if (ordenId) await sembrarOrden(ordenId, cid, [ITEM_ODY()], 250000);
      await sembrarSesion(cid, { estado, cart: CARRITO_ODY(), pendingOrderId: ordenId });
      const antes = ordenId ? (await ordenDoc(ordenId)).updateTime.toMillis() : null;
      const r = await bot(`+${cid}`, texto);
      const ses = await sessionOf(cid);
      const despues = ordenId ? await ordenDoc(ordenId) : null;
      corridas[estado].push({
        texto, cid, reply: String(r?.reply ?? ''), ses,
        avisos: (await notifsHandoffDeCliente(cid)).length,
        ordenes: (await ordersDe(cid)).length,
        ordenIntacta: !despues || (despues.updateTime.toMillis() === antes && despues.data().status === 'PENDING_PAYMENT'),
        puntero: ses?.context?.pendingOrderId ?? null,
        ordenId,
      });
    }
  }
  const noCotiza = (c) =>
    !c.reply.includes('🛒 *Tu carrito:*') && !c.reply.includes('Total:') && !MIL.test(c.reply) &&
    !BANCO.test(c.reply) && !/\bpagar\b/i.test(c.reply);
  const esDeriva = (c) => MSG_DERIVA.test(c.reply) && c.reply.includes('Ana Ownership') && !/130|feed|Meta|precio publicado/i.test(c.reply);
  const derivo = (c) =>
    c.ses?.context?.humanTakeover === true && c.ses?.context?.handoffReason === 'catalog_drift' &&
    c.ses?.context?.handoffSourceId === `deriva-${P_ODYSSEY}` && c.avisos === 1 &&
    (c.ses?.cart?.items ?? []).length === 1 && c.ses?.cart?.subtotal === 250000;

  check('OW-18. los 4 mensajes que disparan pagar Y carrito NO cotizan el precio en deriva (estado CART)',
    corridas.CART.length === 4 && corridas.CART.every(noCotiza),
    corridas.CART.filter((c) => !noCotiza(c)).map((c) => `«${c.texto}» → ${c.reply.slice(0, 60)}`).join(' | '));
  check('OW-18b. …y responden el mensaje CANÓNICO de deriva, sin nombrar el feed, Meta ni el precio en disputa',
    corridas.CART.every(esDeriva), corridas.CART.filter((c) => !esDeriva(c)).map((c) => c.texto).join(','));
  check('OW-18c. efectos en CART: takeover catalog_drift con sourceId de la deriva, UN aviso, carrito intacto, CERO órdenes',
    corridas.CART.every(derivo) && corridas.CART.every((c) => c.ordenes === 0),
    corridas.CART.map((c) => `${c.ses?.context?.handoffReason}/${c.avisos}/${c.ordenes}`).join(' '));

  check('OW-18d. los MISMOS 4 mensajes con el pago ya pedido (AWAITING_PAYMENT) tampoco cotizan',
    corridas.AWAITING_PAYMENT.length === 4 && corridas.AWAITING_PAYMENT.every(noCotiza),
    corridas.AWAITING_PAYMENT.filter((c) => !noCotiza(c)).map((c) => `«${c.texto}» → ${c.reply.slice(0, 60)}`).join(' | '));
  check('OW-18e. …con el mismo mensaje canónico y los mismos efectos (es la intersección, no el estado)',
    corridas.AWAITING_PAYMENT.every(esDeriva) && corridas.AWAITING_PAYMENT.every(derivo),
    corridas.AWAITING_PAYMENT.map((c) => `${c.ses?.context?.handoffReason}/${c.avisos}`).join(' '));
  check('OW-18f. la orden ABIERTA queda intacta y el puntero no se pierde (nadie degrada un pago en curso)',
    corridas.AWAITING_PAYMENT.every((c) => c.ordenIntacta && c.puntero === c.ordenId && c.ordenes === 1),
    corridas.AWAITING_PAYMENT.map((c) => `intacta=${c.ordenIntacta} puntero=${c.puntero}`).join(' '));

  // Idempotencia: el segundo turno ni siquiera vuelve a evaluar el guard (ya hay takeover).
  const cidRepite = corridas.CART[0].cid;
  await bot(`+${cidRepite}`, MENSAJES_MIXTOS[1]);
  check('OW-18g. repetir el turno NO genera un segundo aviso ni una orden (la deriva ES el evento)',
    (await notifsHandoffDeCliente(cidRepite)).length === 1 && (await ordersDe(cidRepite)).length === 0);

  // ── N2: pago PURO (sin token de carrito) — lo tiene que frenar el CHECKOUT, no el guard ──
  const cidN2 = CLIENTES[14];
  await sembrarSesion(cidN2, { estado: 'CART', cart: CARRITO_ODY(), pendingOrderId: null });
  const desdeN2 = tamañoLog();
  const rN2 = await bot(`+${cidN2}`, 'quiero pagar');
  await sleep(400); // el emulador escribe su salida de forma asíncrona
  const trazaN2 = logDesde(desdeN2);
  const sesN2 = await sessionOf(cidN2);
  check('OW-18h. control: el pago PURO no lo agarra el guard conversacional — lo frena el CHECKOUT (traza real)',
    trazaN2.includes('Checkout bloqueado: deriva crítica del dato público') &&
    !trazaN2.includes('Deriva crítica del catálogo → el bot no cotiza y deriva'),
    `traza=${trazaN2.length} bytes`);
  check('OW-18h². …y ese camino tampoco manda banco ni total: deriva igual y no crea la orden',
    !BANCO.test(String(rN2?.reply ?? '')) && !MIL.test(String(rN2?.reply ?? '')) && MSG_DERIVA.test(String(rN2?.reply ?? '')) &&
    sesN2?.context?.handoffReason === 'catalog_drift' && (await ordersDe(cidN2)).length === 0,
    `reply=${String(rN2?.reply ?? '').slice(0, 70)}`);

  // ── N1: el MISMO turno con el producto verified SÍ muestra el carrito (cero sobre-bloqueo) ──
  await setFixture(ITEMS_BASE().map((i) => (i.retailer_id === P_ODYSSEY ? { ...i, price: '₲250.000' } : i)), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  await verificar();
  const sano = [];
  for (const [j, estado] of ['CART', 'AWAITING_PAYMENT'].entries()) {
    const cid = CLIENTES[12 + j];
    for (const texto of MENSAJES_MIXTOS) {
      // Sin deriva no hay takeover, así que el MISMO cliente sirve para los 4 mensajes: solo se
      // repone la sesión (el turno anterior pudo dejarla en otro estado).
      await sembrarSesion(cid, { estado, cart: CARRITO_ODY(), pendingOrderId: null });
      const r = await bot(`+${cid}`, texto);
      sano.push({ texto, estado, reply: String(r?.reply ?? ''), ses: await sessionOf(cid) });
    }
  }
  check('OW-18i. control: con el producto VERIFIED los mismos 8 turnos cotizan el carrito y no derivan',
    sano.length === 8 &&
    sano.every((c) => c.reply.includes('🛒 *Tu carrito:*') && c.reply.includes('250.000') && c.reply.includes('Total:')) &&
    sano.every((c) => c.ses?.context?.humanTakeover !== true),
    sano.filter((c) => !c.reply.includes('🛒 *Tu carrito:*')).map((c) => `${c.estado}:«${c.texto}»`).join(' | '));
  check('OW-18j. y en TODO el escenario no salió ni una escritura hacia Meta', (await writesSnap()).empty);
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-19. La rama de REUSO del checkout falla CERRADO: un pedido ABIERTO no reenvía
//        banco ni total si la deriva no se pudo descartar (leer y no poder leer no
//        son lo mismo cuando hay plata comprometida).
// ═══════════════════════════════════════════════════════════════════════════
{
  // Partida SANA: el feed publica lo mismo que el local (el fixture quedó así de OW-18i).
  const odySano = await productOf(P_ODYSSEY);
  check('OW-19(pre). con el feed corregido EN EL ORIGEN, Odyssey vuelve a estar verified',
    odySano?.metaSyncState === 'verified' && (odySano?.metaDrift ?? null) === null, `state=${odySano?.metaSyncState}`);

  const FRAME_REUSO = 'Checkout frenado: deriva crítica sobre una orden ya creada';
  /** Corrida de "pagar" sobre un pedido ABIERTO, midiendo la traza del frame de reuso. */
  const corridaReuso = async (cid, { estado, ordenId, items = [ITEM_ODY()], cart = CARRITO_ODY() }) => {
    await sembrarOrden(ordenId, cid, items, 250000);
    await sembrarSesion(cid, { estado, cart, pendingOrderId: ordenId });
    const antes = (await ordenDoc(ordenId)).updateTime.toMillis();
    const desde = tamañoLog();
    const r = await bot(`+${cid}`, 'pagar');
    await sleep(400);
    const despues = await ordenDoc(ordenId);
    return {
      reply: String(r?.reply ?? ''), traza: logDesde(desde), ses: await sessionOf(cid),
      ordenIntacta: despues.updateTime.toMillis() === antes && despues.data().status === 'PENDING_PAYMENT',
      puntero: (await sessionOf(cid))?.context?.pendingOrderId ?? null,
      ordenes: (await ordersDe(cid)).length,
    };
  };
  const frenoLimpio = (c) =>
    !c.reply.includes('Seguís con tu pedido pendiente') && !BANCO.test(c.reply) && !MIL.test(c.reply) &&
    MSG_DERIVA.test(c.reply) && c.ses?.context?.humanTakeover === true && c.ses?.context?.handoffReason === 'catalog_drift' &&
    c.ordenIntacta && c.ordenes === 1;

  // ── N3: la rama SANA sigue funcionando exactamente igual (cero regresión del F5) ──
  const n3 = await corridaReuso(CLIENTES[15], { estado: 'CART', ordenId: 'ord-n3' });
  check('OW-19. control: proyección sana + producto verified ⇒ el reuso reenvía el pedido pendiente con banco y total',
    n3.reply.includes('Seguís con tu pedido pendiente') && BANCO.test(n3.reply) && MIL.test(n3.reply) &&
    n3.ses?.state === 'AWAITING_PAYMENT' && n3.puntero === 'ord-n3' && n3.ordenes === 1,
    `reply=${n3.reply.slice(0, 60)} estado=${n3.ses?.state}`);

  // ── 2c: la orden reutilizable no tiene ítems LEGIBLES ⇒ no se manda el total de algo que no
  //    sabemos atribuir. (Una orden con `items: []` no llega a esta rama: `sameCartAsOrder` la
  //    manda a "carrito cambió". Lo que SÍ llega —y es lo que el helper describe— es una orden
  //    cuyos ítems no se pueden leer: acá, un `productId` que quedó guardado como número.)
  const c2c = await corridaReuso(CLIENTES[16], {
    estado: 'CART', ordenId: 'ord-2c',
    items: [{ itemId: 'it-x', productId: 90001, productName: 'Odyssey Ownership', quantity: 1, unitPrice: 250000, subtotal: 250000 }],
    cart: { items: [{ productId: '90001', name: 'Odyssey Ownership', price: 250000, quantity: 1 }], subtotal: 250000 },
  });
  check('OW-19b. orden reutilizable con ítems ILEGIBLES ⇒ bloquea como unverifiable (no se manda el total a ciegas)',
    frenoLimpio(c2c) && trazaCon(c2c.traza, FRAME_REUSO, 'unverifiable'),
    `reply=${c2c.reply.slice(0, 60)} traza=${trazaCon(c2c.traza, FRAME_REUSO, 'unverifiable')}`);

  // ── 2a: la LECTURA de la proyección falla (no es "no hay deriva": es "no pude saberlo") ──
  await inyectarFalla('snapshots');
  const c2a = await corridaReuso(CLIENTES[17], { estado: 'CART', ordenId: 'ord-2a' });
  const c2aPago = await corridaReuso(CLIENTES[18], { estado: 'AWAITING_PAYMENT', ordenId: 'ord-2a2' });
  await inyectarFalla(null);
  check('OW-19c. la proyección no se puede LEER ⇒ el reuso NO reenvía banco ni total: deriva (fail-CLOSED)',
    frenoLimpio(c2a) && frenoLimpio(c2aPago), `cart=${c2a.reply.slice(0, 50)} pago=${c2aPago.reply.slice(0, 50)}`);
  check('OW-19c². la razón estructurada es `unverifiable` sobre los 4 campos críticos (no "drifted_external")',
    trazaCon(c2a.traza, FRAME_REUSO, 'unverifiable') && !trazaCon(c2a.traza, FRAME_REUSO, 'drifted_external') &&
    ['price', 'currency', 'availability', 'inventory'].every((f) => trazaCon(c2a.traza, FRAME_REUSO, f)),
    `traza=${c2a.traza.length} bytes`);
  check('OW-19c³. la orden abierta queda INTACTA y su puntero también (el pedido no desaparece)',
    c2a.ordenIntacta && c2a.puntero === 'ord-2a' && c2aPago.ordenIntacta && c2aPago.puntero === 'ord-2a2' &&
    c2a.ordenes === 1 && c2aPago.ordenes === 1,
    `puntero=${c2a.puntero}/${c2aPago.puntero}`);

  // ── 2b: el gate BARATO por tenant falla, pero el camino con plata no se apoya en él ──
  await setFixture(ITEMS_BASE(), { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });
  await verificar();
  await inyectarFalla('activa');
  const c2b = await corridaReuso(CLIENTES[19], { estado: 'CART', ordenId: 'ord-2b' });
  await inyectarFalla(null);
  check('OW-19d. el gate barato por tenant falla pero `snapshots` responde ⇒ IGUAL bloquea, con razón drifted_external',
    frenoLimpio(c2b) && trazaCon(c2b.traza, FRAME_REUSO, 'drifted_external'),
    `reply=${c2b.reply.slice(0, 60)} traza=${trazaCon(c2b.traza, FRAME_REUSO, 'drifted_external')}`);

  // ── 2e/2f (hallazgo del review adversarial): el fail-closed alcanza SOLO a lo que alguien puede
  //    estar publicando afuera. Mismo tenant gobernado por el feed y misma lectura caída, pero el
  //    pedido es de un producto SIN identidad remota: nadie lo publicó, así que nada puede
  //    contradecir su precio y frenarlo sería castigar por un parpadeo de Firestore. Si tampoco se
  //    puede saber quién está publicado, vuelve a frenar.
  const ITEM_LOCAL = () => ({ itemId: 'it-loc-1', productId: P_LOCAL, productName: 'Local Sin Meta Ownership', quantity: 1, unitPrice: 250000, subtotal: 250000 });
  const CARRITO_LOCAL = () => ({ items: [{ productId: P_LOCAL, name: 'Local Sin Meta Ownership', price: 250000, quantity: 1, imageUrl: IMG(P_LOCAL) }], subtotal: 250000 });
  const localPre = await productOf(P_LOCAL);
  await inyectarFalla('snapshots');
  const c2e = await corridaReuso(CLIENTES[21], { estado: 'CART', ordenId: 'ord-2e', items: [ITEM_LOCAL()], cart: CARRITO_LOCAL() });
  await inyectarFalla(['snapshots', 'identidad']);
  const c2f = await corridaReuso(CLIENTES[22], { estado: 'CART', ordenId: 'ord-2f', items: [ITEM_LOCAL()], cart: CARRITO_LOCAL() });
  await inyectarFalla(null);
  check('OW-19d². la lectura se cae PERO el pedido no tiene nada publicado en Meta ⇒ el reuso sigue (no se castiga por un parpadeo)',
    !localPre?.metaRetailerId && !localPre?.metaProductItemId && !localPre?.metaSyncState &&
    c2e.reply.includes('Seguís con tu pedido pendiente') && BANCO.test(c2e.reply) &&
    c2e.ses?.context?.humanTakeover !== true && c2e.puntero === 'ord-2e' && c2e.ordenes === 1,
    `reply=${c2e.reply.slice(0, 60)} takeover=${c2e.ses?.context?.humanTakeover}`);
  check('OW-19d³. …y si TAMPOCO se puede saber quién está publicado, vuelve a frenar cerrado (unverifiable)',
    frenoLimpio(c2f) && trazaCon(c2f.traza, FRAME_REUSO, 'unverifiable'),
    `reply=${c2f.reply.slice(0, 60)} traza=${trazaCon(c2f.traza, FRAME_REUSO, 'unverifiable')}`);

  // ── N4: sin gobierno externo DECLARADO el guard es inerte y el reuso se comporta como siempre.
  //    Se reproduce la condición de credipower SOBRE EL TENANT DE PRUEBA (credipower no se toca).
  await setCfg(T, { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID });
  const n4 = await corridaReuso(CLIENTES[20], { estado: 'CART', ordenId: 'ord-n4' });
  check('OW-19e. control: nadie declaró gobierno externo ⇒ el reuso reenvía el pedido pendiente igual que siempre',
    n4.reply.includes('Seguís con tu pedido pendiente') && BANCO.test(n4.reply) && n4.puntero === 'ord-n4' &&
    n4.ses?.context?.humanTakeover !== true && (await productOf(P_ODYSSEY))?.metaSyncState === 'drifted_external',
    `reply=${n4.reply.slice(0, 60)}`);
  check('OW-19f. y ningún escenario de reuso escribió una sola vez en Meta', (await writesSnap()).empty);
  await setCfg(T, { enabled: true, mode: 'dry_run', catalogId: CATALOG_ID, ownership: OWN_EXTERNA });
}

// ═══════════════════════════════════════════════════════════════════════════
// OW-20. SYNC APAGADO + GOBIERNO EXTERNO DECLARADO: el guard sigue bloqueando y la
//        reconciliación —que solo LEE— sigue pudiendo correr y refrescar la evidencia.
//        Si el guard está prendido para un tenant, lo que refresca la evidencia también
//        tiene que poder correr: un bloqueo permanente sin salida es tan malo como un
//        verde sin evidencia.
// OW-21. Mapeado SOLO por `metaProductItemId` (vínculo manual legacy): la reconciliación
//        lo procesa y no lo deja trabado en `unverifiable` corrida tras corrida.
// ═══════════════════════════════════════════════════════════════════════════
{
  const B_CAT = 'CAT-E2E';
  const B_ODY = `${PREFIJO}B-ODY`;
  const B_ITEM = `${PREFIJO}B-SOLOITEM`;
  const B_GONE = `${PREFIJO}B-ITEMGONE`;
  const LAST_SYNC = Timestamp.fromMillis(Date.parse('2026-07-29T03:33:00.000Z'));
  const externaB = {
    kind: 'meta_feed', acknowledgedSourceIds: ['feed-e2e'], declaredFields: [],
    fingerprint: 'huella-e2e', acknowledgedByUid: 'uid-owner', acknowledgedAt: now,
  };
  /** El interruptor de ESCRITURA apagado, el catálogo remoto y el gobierno externo declarados. */
  const CFG_B = (over = {}) => ({
    enabled: false, mode: 'off', catalogId: B_CAT,
    ownership: { model: 'external_managed', ownedFields: [], external: externaB, lastSourceCheckAt: null },
    ...over,
  });
  const prodB = (id, over = {}) => ({ ...prod(id), tenantId: T2, categoryId: 'general', syncToMeta: false, ...over });
  const runsB = async () => (await db.collection(`tenants/${T2}/metaCatalogVerificationRuns`).get()).docs.map((d) => d.data());
  const avisoB = () => db.doc(`tenants/${T2}/notifications/catalog-verification-${T2}`).get();
  const notifsB = async () => (await db.collection(`tenants/${T2}/notifications`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const prodDe = (id) => productOf(id, T2);
  const activosDelEmulador = async () =>
    (await db.collection('tenants').get()).docs.filter((d) => d.data().status === 'ACTIVE' && !d.data().deletedAt).length;

  // El tenant de arfagi ya cerró sus escenarios: se le retira la config para que el barrido
  // programado de más abajo mida EXACTAMENTE lo del tenant de prueba (y jamás toque credipower).
  await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});
  await wipeCol(`tenants/${T2}/metaCatalogVerificationRuns`);
  await deleteRefs((await notifsB()).map((n) => db.doc(`tenants/${T2}/notifications/${n.id}`)));
  await setCfg(T2, CFG_B());
  await db.batch()
    // Mapeado por retailer id, con el eje HISTÓRICO ya escrito y el ACTUAL como lo deja la
    // migración: `unverifiable` y SIN `metaVerifiedAt` (o sea, vencido desde el minuto cero).
    .set(db.doc(`tenants/${T2}/products/${B_ODY}`), prodB(B_ODY, {
      metaRetailerId: B_ODY, metaCatalogId: B_CAT, metaProductItemId: `itm-${B_ODY}`,
      metaSyncStatus: 'synced', metaLastSyncAt: LAST_SYNC, metaSyncState: 'unverifiable',
    }))
    // Vínculo manual LEGACY: SOLO `metaProductItemId` (sin retailer id).
    .set(db.doc(`tenants/${T2}/products/${B_ITEM}`), prodB(B_ITEM, {
      metaCatalogId: B_CAT, metaProductItemId: `itm-${B_ITEM}`, metaSyncState: 'unverifiable',
    }))
    .set(db.doc(`tenants/${T2}/products/${B_GONE}`), prodB(B_GONE, {
      metaCatalogId: B_CAT, metaProductItemId: `itm-${B_GONE}`, metaSyncState: 'unverifiable',
    }))
    .commit();
  // Catálogo remoto: Odyssey a ₲130.000 (el feed) y el vinculado a mano SIN retailer id.
  await setFixture([remoto(B_ODY, { price: '₲130.000' }), remoto(B_ITEM, { retailer_id: '' })], { dataSources: [feedCrudo()], feedCount: 1, pagesPerList: 1 });

  // El guard del bot NO depende de nuestro interruptor: con la sync apagada sigue activo.
  const { metaDriftProjection: proyeccion } = await import(new URL('../lib/meta/catalogDriftProjection.js', import.meta.url).href);
  const activaConSyncOff = await proyeccion.activa(T2);
  const snapOdy = (await proyeccion.snapshots(T2, [B_ODY]))[0];
  check('OW-20. con `enabled:false` y `mode:"off"` el guard SIGUE activo (apagar la sync no apaga la honestidad)',
    activaConSyncOff === true && (snapOdy?.externalFields ?? []).includes('price'),
    `activa=${activaConSyncOff} externos=${(snapOdy?.externalFields ?? []).length}`);

  const rB1 = await verificar(ownerBoutique);
  const run1 = (await runsB())[0] ?? null;
  check('OW-20b. …y la reconciliación IGUAL corre: nada de "unavailable", corrida completa y catálogo leído',
    rB1?.ok === true && rB1?.status === 'completed' && (rB1?.pagesDone ?? 0) >= 1 && (rB1?.counters?.remoteItems ?? 0) === 2,
    `status=${rB1?.status} paginas=${rB1?.pagesDone} items=${rB1?.counters?.remoteItems}`);
  check('OW-20c. se creó EXACTAMENTE UN doc de corrida, con la propiedad SANA y el techo dry_run (verificar no habilita escribir)',
    (await runsB()).length === 1 && run1?.catalogId === B_CAT && run1?.ownership?.model === 'external_managed' &&
    run1?.ownership?.degraded === false && (run1?.ownership?.writable ?? ['x']).length === 0 && run1?.ownership?.modeCeiling === 'dry_run',
    `catalogId=${run1?.catalogId} degraded=${run1?.ownership?.degraded} techo=${run1?.ownership?.modeCeiling}`);
  const odyB1 = await prodDe(B_ODY);
  check('OW-20d. la evidencia se REFRESCA: verifiedAt fresco y drifted_external por PRECIO (el caso Odyssey)',
    (odyB1?.metaVerifiedAt?.toMillis?.() ?? 0) >= (run1?.sweepStartedAtMs ?? Infinity) &&
    odyB1?.metaSyncState === 'drifted_external' && JSON.stringify(odyB1?.metaDrift?.fields) === JSON.stringify(['price']) &&
    odyB1?.metaDrift?.owner === 'external' && odyB1?.metaDrift?.severity === 'commercial',
    `state=${odyB1?.metaSyncState} campos=${JSON.stringify(odyB1?.metaDrift?.fields)}`);
  check('OW-20e. CERO escrituras en Meta y el eje HISTÓRICO intacto (status y fecha de la última escritura)',
    (await writesSnap()).empty && odyB1?.metaSyncStatus === 'synced' && odyB1?.metaLastSyncAt?.toMillis?.() === LAST_SYNC.toMillis(),
    `histórico=${odyB1?.metaSyncStatus}/${odyB1?.metaLastSyncAt?.toMillis?.()}`);
  check('OW-20f. sin contradicción que avisar, la campana queda vacía', (await notifsB()).length === 0, `avisos=${(await notifsB()).length}`);

  // ── OW-21 (tras la PRIMERA corrida): el vinculado solo por item id entra a la reconciliación ──
  const itemB1 = await prodDe(B_ITEM);
  const goneB1 = await prodDe(B_GONE);
  check('OW-21. mapeado SOLO por metaProductItemId ⇒ la corrida lo PROCESA (verified con evidencia fresca), no lo saltea',
    itemB1?.metaSyncState === 'verified' && (itemB1?.metaVerifiedAt?.toMillis?.() ?? 0) >= (run1?.sweepStartedAtMs ?? Infinity),
    `state=${itemB1?.metaSyncState} verifiedAt=${itemB1?.metaVerifiedAt ? 'sí' : 'no'}`);
  check('OW-21b. y el que el catálogo NO publica termina en remote_missing (lo observado), jamás en un `unverifiable` sin salida',
    goneB1?.metaSyncState === 'remote_missing' && (goneB1?.metaVerifiedAt?.toMillis?.() ?? 0) >= (run1?.sweepStartedAtMs ?? Infinity),
    `state=${goneB1?.metaSyncState}`);

  // ── Segunda corrida POR EL SCHEDULER (la misma función programada, con el cliente fake) ──
  // No hay endpoint dev para este mantenimiento y fabricar uno sería inventar un camino que
  // producción no tiene: se corre la función REAL en proceso contra el emulador. Con
  // FUNCTIONS_EMULATOR el módulo de catálogo usa su cliente FAKE (cero red, cero Meta).
  process.env.FUNCTIONS_EMULATOR = 'true';
  const { runMetaCatalogVerificationMaintenance } = await import(new URL('../lib/functions/scheduled/metaCatalogVerification.js', import.meta.url).href);
  const activos = await activosDelEmulador();
  const resumen1 = await runMetaCatalogVerificationMaintenance();
  const run2 = (await runsB()).find((r) => r.runId !== run1?.runId) ?? null;
  const odyB2 = await prodDe(B_ODY);
  check('OW-20g. el barrido PROGRAMADO corre el tenant con la sync apagada y saltea a los que no declararon gobierno externo',
    resumen1.corridas === 1 && resumen1.completadas === 1 && resumen1.bloqueadas === 0 && resumen1.errores === 0 &&
    resumen1.saltadas === activos - 1,
    `resumen=${JSON.stringify(resumen1)} activos=${activos}`);
  check('OW-20h. la segunda corrida es IDEMPOTENTE: mismo estado, mismo detectedAt (no re-alerta) y cero avisos',
    odyB2?.metaSyncState === 'drifted_external' &&
    odyB2?.metaDrift?.detectedAt?.toMillis?.() === odyB1?.metaDrift?.detectedAt?.toMillis?.() &&
    (await notifsB()).length === 0 && (await writesSnap()).empty,
    `detectedAt igual=${odyB2?.metaDrift?.detectedAt?.toMillis?.() === odyB1?.metaDrift?.detectedAt?.toMillis?.()}`);
  // Cada barrido es UNA corrida (el doc del run es evidencia histórica): lo que no puede quedar
  // es una corrida colgada en `running`, ni dos corridas activas para el mismo tenant.
  check('OW-20h². y deja su corrida CERRADA (dos barridos, dos docs completados, ninguno colgado)',
    (await runsB()).length === 2 && (await runsB()).every((r) => r.status === 'completed'),
    `runs=${(await runsB()).map((r) => r.status).join(',')}`);
  const itemB2 = await prodDe(B_ITEM);
  const goneB2 = await prodDe(B_GONE);
  check('OW-21c. corrida tras corrida, el vinculado por item id NO vuelve a `unverifiable`: su evidencia se refresca',
    itemB2?.metaSyncState === 'verified' && (itemB2?.metaVerifiedAt?.toMillis?.() ?? 0) >= (run2?.sweepStartedAtMs ?? Infinity) &&
    goneB2?.metaSyncState === 'remote_missing' && (goneB2?.metaVerifiedAt?.toMillis?.() ?? 0) >= (run2?.sweepStartedAtMs ?? Infinity),
    `item=${itemB2?.metaSyncState} gone=${goneB2?.metaSyncState}`);
  // Caso credipower (forma sin `config/meta`): ni una corrida, ni un aviso, ni un producto.
  check('OW-20i. credipower (sin config de catálogo) sigue intocado: cero corridas, cero avisos, cero productos',
    (await db.collection(`tenants/${T3}/metaCatalogVerificationRuns`).get()).empty &&
    (await db.collection(`tenants/${T3}/notifications`).get()).empty &&
    (await db.collection(`tenants/${T3}/products`).get()).empty);

  // ── Config CONTRADICTORIA: gobierno externo declarado y ningún catálogo que leer ──
  await setCfg(T2, CFG_B({ catalogId: '' }));
  const { err: errBloqueo, errMsg: msgBloqueo } = await call('metaCatalogVerificationRun', ownerBoutique, {});
  const aviso1 = await avisoB();
  check('OW-20j. gobierno externo SIN catálogo que leer ⇒ la corrida se BLOQUEA (no se saltea en silencio) y cero corridas nuevas',
    errBloqueo === 'FAILED_PRECONDITION' && /sistema externo/i.test(String(msgBloqueo ?? '')) && (await runsB()).length === 2,
    `err=${errBloqueo}`);
  check('OW-20j². y se abre UN aviso administrativo con las DOS salidas humanas (configurar el catálogo o retirar la declaración)',
    aviso1.exists && aviso1.data()?.type === 'catalog_verification_blocked' && aviso1.data()?.category === 'catalog_verification' &&
    aviso1.data()?.read === false && aviso1.data()?.resolvedAt === null &&
    /Configurá el catálogo de Meta/.test(String(aviso1.data()?.body ?? '')) && /quitá la declaración de fuente externa/.test(String(aviso1.data()?.body ?? '')) &&
    (await notifsB()).length === 1,
    `type=${aviso1.data()?.type} avisos=${(await notifsB()).length}`);
  // Repetir no duplica ni reabre lo que el owner ya marcó leído.
  await db.doc(`tenants/${T2}/notifications/catalog-verification-${T2}`).set({ read: true, readAt: Timestamp.now() }, { merge: true });
  await call('metaCatalogVerificationRun', ownerBoutique, {});
  const resumen2 = await runMetaCatalogVerificationMaintenance();
  const aviso2 = await avisoB();
  check('OW-20k. repetir el bloqueo no duplica el aviso ni lo reabre, y el scheduler lo cuenta APARTE de las salteadas',
    (await notifsB()).length === 1 && aviso2.data()?.read === true &&
    aviso2.data()?.createdAt?.toMillis() === aviso1.data()?.createdAt?.toMillis() &&
    resumen2.bloqueadas === 1 && resumen2.corridas === 0 && resumen2.errores === 0 && resumen2.saltadas === activos - 1,
    `resumen=${JSON.stringify(resumen2)}`);
  // Salida 1: configurar el catálogo ⇒ la corrida completa y el MISMO aviso se autocierra.
  await setCfg(T2, CFG_B());
  const rB3 = await verificar(ownerBoutique);
  const aviso3 = await avisoB();
  check('OW-20l. al configurar el catálogo la corrida completa y el MISMO aviso se AUTOCIERRA (sin crear otro)',
    rB3?.status === 'completed' && (await notifsB()).length === 1 && !!aviso3.data()?.resolvedAt &&
    (await runsB()).length === 3,
    `resolvedAt=${aviso3.data()?.resolvedAt ? 'sí' : 'no'} avisos=${(await notifsB()).length}`);
  // Salida 2: retirar la declaración externa ⇒ el aviso también se cierra y el tenant vuelve a
  // saltearse en silencio (sin gobierno externo el guard está inerte: no hay nada que refrescar).
  await setCfg(T2, CFG_B({ catalogId: '' }));
  await call('metaCatalogVerificationRun', ownerBoutique, {}); // reabre el aviso
  await setCfg(T2, { enabled: false, mode: 'off', catalogId: '', ownership: { model: 'external_managed', ownedFields: [], external: null, lastSourceCheckAt: null } });
  const { err: errSinGobierno } = await call('metaCatalogVerificationRun', ownerBoutique, {});
  const aviso4 = await avisoB();
  const resumen3 = await runMetaCatalogVerificationMaintenance();
  check('OW-20m. retirar la declaración externa cierra el aviso igual y la corrida vuelve a saltearse en silencio',
    errSinGobierno === 'FAILED_PRECONDITION' && !!aviso4.data()?.resolvedAt && (await notifsB()).length === 1 &&
    resumen3.bloqueadas === 0 && resumen3.corridas === 0 && resumen3.saltadas === activos,
    `err=${errSinGobierno} resumen=${JSON.stringify(resumen3)}`);
  // Salida 3 (hallazgo del review adversarial): DESCONECTARSE borrando `catalogSync` entero. La
  // elegibilidad pasa a `no_catalog_sync`, que antes no cerraba nada: el aviso "No podemos
  // verificar tu catálogo" quedaba abierto PARA SIEMPRE en una empresa que ya se desconectó.
  await setCfg(T2, CFG_B({ catalogId: '' }));
  await call('metaCatalogVerificationRun', ownerBoutique, {}); // reabre el aviso
  const avisoReabierto = await avisoB();
  await db.doc(`tenants/${T2}/config/meta`).delete().catch(() => {});
  const { err: errDesconectado } = await call('metaCatalogVerificationRun', ownerBoutique, {});
  const aviso5 = await avisoB();
  check('OW-20o. borrar `catalogSync` entero (desconectarse) TAMBIÉN cierra el aviso: nunca queda huérfano',
    avisoReabierto.data()?.resolvedAt === null && errDesconectado === 'FAILED_PRECONDITION' &&
    !!aviso5.data()?.resolvedAt && (await notifsB()).length === 1,
    `err=${errDesconectado} reabierto=${avisoReabierto.data()?.resolvedAt === null} cerrado=${aviso5.data()?.resolvedAt ? 'sí' : 'no'}`);

  // Gobierno externo SOLO COSMÉTICO: el guard del bot exige un campo COMERCIAL para bloquear una
  // venta, así que con el feed publicando título e imagen queda inerte — y si el guard no bloquea
  // nada, no hay evidencia que refrescar ni razón para paginar el catálogo remoto dos veces por día.
  await setCfg(T2, {
    enabled: false, mode: 'off', catalogId: B_CAT,
    ownership: {
      model: 'hybrid', ownedFields: ['price', 'currency', 'availability', 'inventory'],
      external: { ...externaB, declaredFields: ['title', 'image'] }, lastSourceCheckAt: null,
    },
  });
  const runsAntesCosmetico = (await runsB()).length;
  const { err: errCosmetico, errMsg: msgCosmetico } = await call('metaCatalogVerificationRun', ownerBoutique, {});
  const resumen4 = await runMetaCatalogVerificationMaintenance();
  check('OW-20p. gobierno externo SOLO cosmético ⇒ salteada, no bloqueada: cero corridas y cero gasto contra Meta',
    errCosmetico === 'FAILED_PRECONDITION' && !/sistema externo/i.test(String(msgCosmetico ?? '')) &&
    (await runsB()).length === runsAntesCosmetico && resumen4.corridas === 0 && resumen4.bloqueadas === 0 &&
    resumen4.saltadas === activos && !!(await avisoB()).data()?.resolvedAt,
    `err=${errCosmetico} resumen=${JSON.stringify(resumen4)}`);

  check('OW-20n. y todo el bloque de reconciliación con la sync apagada no escribió NADA en Meta', (await writesSnap()).empty);
}

// ═══════════════════════════════════════════════════════════════════════════
// Limpieza (deja el emulador listo para las regresiones)
// ═══════════════════════════════════════════════════════════════════════════
await wipePrograma();
await db.doc(`tenants/${T}/config/meta`).delete().catch(() => {});
await db.doc(`tenants/${T2}/config/meta`).delete().catch(() => {});
if (checkoutPrevio) await db.doc(`tenants/${T}/config/checkout`).set(checkoutPrevio); else await db.doc(`tenants/${T}/config/checkout`).delete().catch(() => {});
await setFixture([], { dataSources: [], feedCount: 0, pagesPerList: 1 });

const okCount = results.filter(Boolean).length;
console.log(`\nRESULTADO OWNERSHIP-MODEL (E2E fake): ${okCount === results.length ? 'TODO OK ✅' : 'FALLAS ❌'} (${okCount}/${results.length})`);
process.exit(okCount === results.length ? 0 : 1);
