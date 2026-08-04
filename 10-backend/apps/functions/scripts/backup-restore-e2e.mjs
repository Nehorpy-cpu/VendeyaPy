/**
 * backup-restore-e2e.mjs — La prueba que convierte "tenemos backup" en un hecho.
 * =============================================================================
 * Un backup no está probado hasta que se RESTAURÓ. Este script hace el ciclo completo, contra el
 * EMULADOR y nunca contra producción:
 *
 *   semilla sintética → backup → **mutación** del origen → restore en un destino AISLADO →
 *   equivalencia de conteos, hashes y muestras.
 *
 * La mutación es la parte que la mayoría de las "pruebas de backup" se saltea: sin ella, comparar el
 * destino contra el origen no demuestra nada (podrían coincidir porque nadie tocó nada). Acá se
 * cambia un precio, se borra un mensaje, se corrompe el ciphertext de un secreto y se rompen los
 * claims de un usuario — y después se exige que el restore reponga exactamente el estado del backup.
 *
 * QUÉ COMPRUEBA, punto por punto:
 *   · subcolecciones profundas (mensajes, sesiones, ítems de pedido) — lo que el exportador perdía;
 *   · sesiones POR CANAL (ADR-0017 §2): dos canales del mismo cliente no se mezclan;
 *   · el índice global de ruteo del inbound (`metaExternalIndex`);
 *   · las conexiones Meta y su referencia de secreto;
 *   · **que el ciphertext restaurado DESCIFRA al mismo plaintext** — comparando hashes, sin imprimir
 *     jamás el valor;
 *   · usuarios y **custom claims** (sin ellos el tenant restaurado es inaccesible);
 *   · tipos: `Timestamp`, `GeoPoint` y `Bytes` vuelven como lo que eran;
 *   · padres FANTASMA (documento inexistente con subcolecciones), que `.get()` no ve;
 *   · inventario de Storage con verificación de checksum sobre una muestra.
 *
 * SOBRE LA VERIFICACIÓN CON META: el programa pide comprobar el descifrado con una llamada Graph
 * read-only. Este script **no llama a graph.facebook.com** — está prohibido en este programa. La
 * prueba equivalente que sí se puede hacer sin red es la de arriba: el ciphertext restaurado
 * descifra al mismo plaintext. La verificación contra Graph queda documentada como paso del
 * Programa 2 en `docs/backup-restore.md`.
 *
 * USO (con los emuladores levantados):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   node scripts/backup-restore-e2e.mjs
 *
 * Sale 0 solo si TODAS las comprobaciones pasan.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, GeoPoint } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { codificar, hashDoc, huella } from './backup-lib.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = resolve(AQUI, '..');

// El script corre contra el emulador con una clave de cifrado SINTÉTICA. Se setea antes de importar
// el módulo compilado de crypto, que la lee vía `getConfig()`.
const ENV_SINTETICO = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  N8N_BASE_URL: 'http://localhost:5678',
  N8N_INTERNAL_SECRET: 'e2e-n8n-internal-secret-00000000000000000',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'e2e-verify-token',
  WHATSAPP_APP_SECRET: 'e2e-app-secret',
  TENANT_SECRETS_ENCRYPTION_KEY: 'e2e-tenant-encryption-key-0000000000000000',
  API_BASE_URL: 'http://localhost:5001',
  WEB_BASE_URL: 'http://localhost:3000',
};
for (const [k, v] of Object.entries(ENV_SINTETICO)) process.env[k] ??= v;

const resultados = [];
const check = (nombre, ok, extra = '') => {
  resultados.push({ nombre, ok: Boolean(ok) });
  console.log(`${ok ? '✅' : '❌'} ${nombre}${extra ? `  — ${extra}` : ''}`);
};

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

function correr(script, args, { esperaFallo = false } = {}) {
  try {
    const salida = execFileSync(process.execPath, [join(AQUI, script), ...args], {
      cwd: FUNCTIONS_DIR, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, salida };
  } catch (e) {
    if (!esperaFallo) console.error(`   ↳ ${script} falló:\n${String(e.stdout ?? '')}${String(e.stderr ?? '')}`);
    return { code: e.status ?? 1, salida: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Recorre un subárbol completo y devuelve `path → hash` (la misma función que usa el backup). */
async function fotografiar(db, rutaTenant) {
  const foto = new Map();
  const recorrer = async (colRef) => {
    for (const docRef of await colRef.listDocuments()) {
      const snap = await docRef.get();
      if (snap.exists) foto.set(docRef.path, hashDoc(codificar(snap.data() ?? {})));
      for (const sub of await docRef.listCollections()) await recorrer(sub);
    }
  };
  const raiz = db.doc(rutaTenant);
  const snap = await raiz.get();
  if (snap.exists) foto.set(raiz.path, hashDoc(codificar(snap.data() ?? {})));
  for (const sub of await raiz.listCollections()) await recorrer(sub);
  return foto;
}

async function main() {
  // ---------------------------------------------------------------------
  // 0. Precondiciones — este script JAMÁS puede correr contra algo real
  // ---------------------------------------------------------------------
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('[e2e] ABORTADO: falta FIRESTORE_EMULATOR_HOST. Esta prueba corre SOLO contra el emulador.');
  }
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error('[e2e] ABORTADO: falta FIREBASE_AUTH_EMULATOR_HOST. La identidad es parte de la prueba, no un extra.');
  }
  const cryptoCompilado = join(FUNCTIONS_DIR, 'lib', 'lib', 'crypto.js');
  if (!existsSync(cryptoCompilado)) {
    throw new Error('[e2e] ABORTADO: falta lib/lib/crypto.js. Corré `pnpm --filter functions build` antes: la prueba de descifrado usa el módulo REAL, no una reimplementación.');
  }
  const { encrypt, decrypt } = await import(`file://${cryptoCompilado.replace(/\\/g, '/')}`);

  const PROY_ORIGEN = 'demo-aiafg';
  const PROY_DESTINO = process.argv.includes('--destino') ? process.argv[process.argv.indexOf('--destino') + 1] : 'demo-restore-aiafg';
  const TENANT = `e2e-${Date.now()}`;
  const dirBackup = mkdtempSync(join(tmpdir(), 'vpw-backup-e2e-'));
  const dirReporte = mkdtempSync(join(tmpdir(), 'vpw-restore-e2e-'));
  const BUCKET = `${PROY_ORIGEN}.appspot.com`;

  console.log(`[e2e] origen=${PROY_ORIGEN} destino AISLADO=${PROY_DESTINO} tenant#${huella(TENANT)}`);
  console.log(`[e2e] backup en ${dirBackup}`);

  const appO = initializeApp({ projectId: PROY_ORIGEN, storageBucket: BUCKET }, 'origen');
  const appD = initializeApp({ projectId: PROY_DESTINO }, 'destino');
  const dbO = getFirestore(appO);
  const dbD = getFirestore(appD);
  const authO = getAuth(appO);
  const authD = getAuth(appD);

  // ---------------------------------------------------------------------
  // 1. Semilla sintética — todo lo que el exportador perdía
  // ---------------------------------------------------------------------
  const TOKEN_SINTETICO = `TOKEN-SINTETICO-${TENANT}`; // jamás un token real
  const cifrado = encrypt(TOKEN_SINTETICO);
  const NOMBRE_SECRETO = `meta-token-${TENANT}`;
  // El PNID tiene que ser ÚNICO por corrida. Con un valor fijo, la segunda corrida encontraba en el
  // destino el `metaExternalIndex/whatsapp_<pnid>` de la primera —apuntando a otro tenant— y el
  // restore abortaba por divergencia. Era un choque de datos de prueba, no un defecto de la
  // herramienta; el caso quedó cableado más abajo como comprobación explícita.
  const PNID = `9${TENANT.replace(/\D/g, '')}`;
  const CANAL_A = `wa_${PNID}`;
  const CANAL_B = 'active'; // canal legacy (ADR-0017 §2: no se migra)

  await dbO.doc(`tenants/${TENANT}`).set({ name: 'Tenant E2E', createdAt: Timestamp.fromMillis(1_770_000_000_000), plan: 'growth' });
  await dbO.doc(`tenants/${TENANT}/products/p1`).set({ name: 'Producto E2E', price: 250000, updatedAt: Timestamp.fromMillis(1_770_000_001_000) });
  await dbO.doc(`tenants/${TENANT}/customers/c1/messages/m1`).set({ text: 'hola', at: Timestamp.fromMillis(1_770_000_002_000), inbound: true });
  await dbO.doc(`tenants/${TENANT}/customers/c1/messages/m2`).set({ text: 'chau', at: Timestamp.fromMillis(1_770_000_003_000), inbound: false });
  await dbO.doc(`tenants/${TENANT}/customers/c1/sessions/${CANAL_A}`).set({ state: 'AWAITING_PAYMENT', humanTakeover: true, canal: CANAL_A });
  await dbO.doc(`tenants/${TENANT}/customers/c1/sessions/${CANAL_B}`).set({ state: 'IDLE', humanTakeover: false, canal: CANAL_B });
  await dbO.doc(`tenants/${TENANT}/orders/o1`).set({ total: 280000, ubicacion: new GeoPoint(-25.2637, -57.5759), comprobante: Buffer.from([1, 2, 3]) });
  await dbO.doc(`tenants/${TENANT}/orders/o1/items/i1`).set({ productId: 'p1', qty: 1, price: 250000 });
  await dbO.doc(`tenants/${TENANT}/auditLogs/a1`).set({ action: 'e2e', at: Timestamp.fromMillis(1_770_000_004_000) });
  await dbO.doc(`tenants/${TENANT}/metaConnections/main`).set({ tokenSecretRef: `secret://firestore/${NOMBRE_SECRETO}`, status: 'active' });
  await dbO.doc(`secrets/${NOMBRE_SECRETO}`).set({ name: NOMBRE_SECRETO, ciphertext: cifrado, updatedAt: Timestamp.now() });
  await dbO.doc(`metaExternalIndex/whatsapp_${PNID}`).set({ tenantId: TENANT, platform: 'whatsapp', externalId: PNID, automationMode: 'inactive', status: 'active' });
  await dbO.doc(`users/u-${TENANT}`).set({ tenantId: TENANT, role: 'TENANT_OWNER', email: `owner-${TENANT}@example.test` });
  // Padre FANTASMA: el documento NO existe, la subcolección sí. `.get()` no lo ve; `listDocuments()` sí.
  await dbO.doc(`tenants/${TENANT}/customers/FANTASMA/messages/m9`).set({ text: 'colgado de un padre inexistente' });

  await authO.createUser({ uid: `u-${TENANT}`, email: `owner-${TENANT}@example.test`, displayName: 'Owner E2E' });
  await authO.setCustomUserClaims(`u-${TENANT}`, { tenantId: TENANT, role: 'TENANT_OWNER' });
  await authO.createUser({ uid: `s-${TENANT}`, email: `seller-${TENANT}@example.test` });
  await authO.setCustomUserClaims(`s-${TENANT}`, { tenantId: TENANT, role: 'SELLER' });
  await authO.createUser({ uid: `ajeno-${TENANT}`, email: `ajeno-${TENANT}@example.test` });
  await authO.setCustomUserClaims(`ajeno-${TENANT}`, { tenantId: 'OTRO-TENANT', role: 'TENANT_OWNER' });

  let storageOk = null;
  const contenidoObjeto = Buffer.from(`objeto sintetico ${TENANT}`);
  if (process.env.STORAGE_EMULATOR_HOST) {
    try {
      await getStorage(appO).bucket(BUCKET).file(`tenants/${TENANT}/products/p1/foto.bin`).save(contenidoObjeto, { contentType: 'application/octet-stream', resumable: false });
      storageOk = true;
    } catch (e) {
      storageOk = false;
      console.warn(`[e2e] no se pudo sembrar Storage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const fotoOriginal = await fotografiar(dbO, `tenants/${TENANT}`);
  check('semilla: el subárbol del tenant tiene subcolecciones profundas', fotoOriginal.size >= 9, `${fotoOriginal.size} documentos`);

  // ---------------------------------------------------------------------
  // 2. Backup
  // ---------------------------------------------------------------------
  const argsBase = ['--project', PROY_ORIGEN, '--tenant', TENANT, '--out', dirBackup];
  const dry = correr('backup-firestore.mjs', argsBase);
  check('backup: el DRY-RUN no escribe nada', dry.code === 0 && !existsSync(join(dirBackup, 'firestore.ndjson')));

  const bfs = correr('backup-firestore.mjs', [...argsBase, '--apply']);
  check('backup Firestore: exit 0 y volcado escrito', bfs.code === 0 && existsSync(join(dirBackup, 'firestore.ndjson')));

  const bauth = correr('backup-auth.mjs', [...argsBase, '--apply']);
  check('backup Auth: exit 0 y volcado escrito', bauth.code === 0 && existsSync(join(dirBackup, 'auth.ndjson')));

  const { readFileSync } = await import('node:fs');
  const manFs = JSON.parse(readFileSync(join(dirBackup, 'manifest-firestore.json'), 'utf8'));
  const manAuth = JSON.parse(readFileSync(join(dirBackup, 'manifest-auth.json'), 'utf8'));
  const lineas = readFileSync(join(dirBackup, 'firestore.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const porRuta = new Map(lineas.map((l) => [l.path, l]));

  check('backup: incluye MENSAJES (el exportador los perdía)', porRuta.has(`tenants/${TENANT}/customers/c1/messages/m1`) && porRuta.has(`tenants/${TENANT}/customers/c1/messages/m2`));
  check('backup: incluye las DOS sesiones por canal (ADR-0017 §2)', porRuta.has(`tenants/${TENANT}/customers/c1/sessions/${CANAL_A}`) && porRuta.has(`tenants/${TENANT}/customers/c1/sessions/${CANAL_B}`));
  check('backup: incluye los ÍTEMS de pedido', porRuta.has(`tenants/${TENANT}/orders/o1/items/i1`));
  check('backup: incluye el índice global de RUTEO del inbound', porRuta.has(`metaExternalIndex/whatsapp_${PNID}`));
  check('backup: incluye el CIPHERTEXT del secreto referenciado', porRuta.has(`secrets/${NOMBRE_SECRETO}`));
  check('backup: incluye el usuario global del tenant', porRuta.has(`users/u-${TENANT}`));
  check('backup: registra el padre FANTASMA sin inventarlo', porRuta.get(`tenants/${TENANT}/customers/FANTASMA`)?.existe === false);
  check('backup: NO guarda el plaintext del secreto en ningún lado',
    !readFileSync(join(dirBackup, 'firestore.ndjson'), 'utf8').includes(TOKEN_SINTETICO));
  check('backup Auth: trae SOLO los usuarios del tenant (2 de 3)', manAuth.usuarios.delTenant === 2, JSON.stringify(manAuth.rolesPorConteo));
  check('backup Auth: NO guarda hashes de contraseña', !readFileSync(join(dirBackup, 'auth.ndjson'), 'utf8').match(/passwordHash|passwordSalt/));
  check('manifiesto: advierte que un restore NO deshace lo que hizo Meta ni la app del vendedor',
    manFs.advertencias.some((a) => /no deshace/i.test(a) && /Meta/.test(a)) && manFs.advertencias.some((a) => /des-onboardea/i.test(a)));
  check('manifiesto: registra las 14 semanas del backup gestionado y que el TTL no se repone',
    manFs.advertencias.some((a) => /14 semanas/i.test(a)) && manFs.advertencias.some((a) => /NO REPONE LAS POLÍTICAS TTL/i.test(a)));

  // Storage (inventario + muestra verificada por checksum)
  if (storageOk) {
    const bst = correr('backup-storage.mjs', [...argsBase, '--bucket', BUCKET, '--muestra', '2', '--apply']);
    const manSt = bst.code === 0 ? JSON.parse(readFileSync(join(dirBackup, 'manifest-storage.json'), 'utf8')) : null;
    check('backup Storage: inventario con muestra verificada por checksum',
      bst.code === 0 && manSt?.resumen.total >= 1 && manSt?.muestreo.fallidos === 0, manSt ? `objetos=${manSt.resumen.total} verificados=${manSt.muestreo.verificados}` : '');
  } else {
    console.log('⏭️  Storage: SALTEADO (STORAGE_EMULATOR_HOST no está seteado). No cuenta como aprobado.');
  }

  // ---------------------------------------------------------------------
  // 3. Mutación sintética del ORIGEN — sin esto, comparar no demuestra nada
  // ---------------------------------------------------------------------
  await dbO.doc(`tenants/${TENANT}/products/p1`).set({ name: 'Producto E2E', price: 1, updatedAt: Timestamp.fromMillis(1_770_000_009_000) });
  await dbO.doc(`tenants/${TENANT}/customers/c1/messages/m2`).delete();
  await dbO.doc(`secrets/${NOMBRE_SECRETO}`).set({ name: NOMBRE_SECRETO, ciphertext: 'AAAA:BBBB:CCCC', updatedAt: Timestamp.now() });
  await authO.setCustomUserClaims(`u-${TENANT}`, { tenantId: TENANT, role: 'SELLER' }); // degradación de permisos
  const fotoMutada = await fotografiar(dbO, `tenants/${TENANT}`);
  check('mutación: el origen cambió de verdad', fotoMutada.get(`tenants/${TENANT}/products/p1`) !== fotoOriginal.get(`tenants/${TENANT}/products/p1`));

  // ---------------------------------------------------------------------
  // 4. Restore en un destino AISLADO
  // ---------------------------------------------------------------------
  const prodBloqueado = correr('restore-firestore.mjs', ['--project', 'vpw-prod-dd6ff', '--desde', dirBackup, '--out', dirReporte, '--apply'], { esperaFallo: true });
  check('restore: contra PRODUCCIÓN aborta con exit ≠ 0', prodBloqueado.code !== 0 && /destino_produccion/.test(prodBloqueado.salida));

  const argsRestore = ['--project', PROY_DESTINO, '--desde', dirBackup, '--out', dirReporte];
  const dryRestore = correr('restore-firestore.mjs', argsRestore);
  check('restore: el DRY-RUN sale 0 e imprime la huella del destino', dryRestore.code === 0 && /huella del destino: [0-9a-f]{12}/.test(dryRestore.salida));
  const huellaDestino = /huella del destino: ([0-9a-f]{12})/.exec(dryRestore.salida)?.[1];

  const huellaAjena = 'ffffffffffff';
  const malaConfirmacion = correr('restore-firestore.mjs', [...argsRestore, '--confirmo', huellaAjena, '--apply'], { esperaFallo: true });
  check('restore: una confirmación que no corresponde al destino aborta', malaConfirmacion.code !== 0 && /confirmacion_no_coincide/.test(malaConfirmacion.salida));

  const rfs = correr('restore-firestore.mjs', [...argsRestore, '--confirmo', huellaDestino, '--apply']);
  check('restore Firestore: exit 0 con verificación posterior por hash', rfs.code === 0);

  const argsRestoreAuth = ['--project', PROY_DESTINO, '--desde', dirBackup, '--out', dirReporte];
  const dryRestoreAuth = correr('restore-auth.mjs', argsRestoreAuth);
  const huellaAuth = /huella del destino: ([0-9a-f]{12})/.exec(dryRestoreAuth.salida)?.[1];
  const rauth = correr('restore-auth.mjs', [...argsRestoreAuth, '--confirmo', huellaAuth ?? 'sin-huella', '--apply']);
  check('restore Auth: exit 0', rauth.code === 0);

  // ---------------------------------------------------------------------
  // 5. Equivalencia
  // ---------------------------------------------------------------------
  const fotoDestino = await fotografiar(dbD, `tenants/${TENANT}`);
  const faltantes = [...fotoOriginal.keys()].filter((p) => !fotoDestino.has(p));
  const distintos = [...fotoOriginal.entries()].filter(([p, h]) => fotoDestino.get(p) !== h).map(([p]) => p);
  check('equivalencia: mismo CONTEO de documentos que el backup', fotoDestino.size === fotoOriginal.size, `origen=${fotoOriginal.size} destino=${fotoDestino.size}`);
  check('equivalencia: TODOS los hashes coinciden con el estado del backup', faltantes.length === 0 && distintos.length === 0,
    faltantes.length || distintos.length ? `faltan=${faltantes.length} difieren=${distintos.length}` : '');

  const prodRest = (await dbD.doc(`tenants/${TENANT}/products/p1`).get()).data();
  check('muestra: el precio restaurado es el del BACKUP, no el mutado', prodRest?.price === 250000);
  check('muestra: el mensaje borrado en el origen VOLVIÓ', (await dbD.doc(`tenants/${TENANT}/customers/c1/messages/m2`).get()).exists);

  const sesA = (await dbD.doc(`tenants/${TENANT}/customers/c1/sessions/${CANAL_A}`).get()).data();
  const sesB = (await dbD.doc(`tenants/${TENANT}/customers/c1/sessions/${CANAL_B}`).get()).data();
  check('muestra: las sesiones POR CANAL no se mezclaron', sesA?.state === 'AWAITING_PAYMENT' && sesA?.humanTakeover === true && sesB?.state === 'IDLE' && sesB?.humanTakeover === false);

  const idx = (await dbD.doc(`metaExternalIndex/whatsapp_${PNID}`).get()).data();
  check('muestra: el ruteo global del inbound se restauró con su automationMode', idx?.tenantId === TENANT && idx?.automationMode === 'inactive');

  const conn = (await dbD.doc(`tenants/${TENANT}/metaConnections/main`).get()).data();
  check('muestra: la conexión Meta conserva su referencia de secreto', conn?.tokenSecretRef === `secret://firestore/${NOMBRE_SECRETO}`);

  const ordenRest = (await dbD.doc(`tenants/${TENANT}/orders/o1`).get()).data();
  check('tipos: el GeoPoint volvió como GeoPoint', ordenRest?.ubicacion instanceof GeoPoint && Math.abs(ordenRest.ubicacion.latitude + 25.2637) < 1e-6);
  check('tipos: los Bytes volvieron byte a byte', Buffer.isBuffer(ordenRest?.comprobante) && [...ordenRest.comprobante].join(',') === '1,2,3');
  const tenantRest = (await dbD.doc(`tenants/${TENANT}`).get()).data();
  check('tipos: el Timestamp volvió como Timestamp', tenantRest?.createdAt instanceof Timestamp && tenantRest.createdAt.toMillis() === 1_770_000_000_000);

  const fantasma = await dbD.doc(`tenants/${TENANT}/customers/FANTASMA`).get();
  const fantasmaHijo = await dbD.doc(`tenants/${TENANT}/customers/FANTASMA/messages/m9`).get();
  check('padre fantasma: la subcolección volvió y el padre sigue sin existir', fantasmaHijo.exists && !fantasma.exists);

  // --- Descifrado: el ciphertext restaurado descifra al MISMO plaintext ---
  const secretoRest = (await dbD.doc(`secrets/${NOMBRE_SECRETO}`).get()).data();
  let descifradoOk = false;
  try {
    // Nunca se imprime el valor: se comparan hashes.
    descifradoOk = sha(decrypt(secretoRest?.ciphertext)) === sha(TOKEN_SINTETICO);
  } catch { descifradoOk = false; }
  check('DESCIFRADO: el ciphertext restaurado descifra al MISMO plaintext (comparado por hash)', descifradoOk);
  check('descifrado: el origen quedó con el ciphertext corrompido de la mutación (la prueba no es trivial)',
    (await dbO.doc(`secrets/${NOMBRE_SECRETO}`).get()).data()?.ciphertext === 'AAAA:BBBB:CCCC');

  // --- Identidad ---
  const owner = await authD.getUser(`u-${TENANT}`);
  const seller = await authD.getUser(`s-${TENANT}`);
  check('identidad: el owner se restauró con el MISMO uid', owner.uid === `u-${TENANT}`);
  check('identidad: los CLAIMS volvieron al estado del backup (no al mutado)', owner.customClaims?.role === 'TENANT_OWNER' && owner.customClaims?.tenantId === TENANT);
  check('identidad: el SELLER también se restauró', seller.customClaims?.role === 'SELLER');
  let ajenoAusente = false;
  try { await authD.getUser(`ajeno-${TENANT}`); } catch { ajenoAusente = true; }
  check('aislamiento: el usuario de OTRO tenant no se restauró', ajenoAusente);

  // --- Idempotencia ---
  const segundo = correr('restore-firestore.mjs', [...argsRestore, '--confirmo', huellaDestino, '--apply']);
  check('idempotencia: repetir el restore sobre un destino ya restaurado sale 0 y no reescribe nada',
    segundo.code === 0 && /"aEscribir":0/.test(segundo.salida.replace(/\s/g, '')));

  // --- Conflicto deliberado: el destino cambió después del restore ---
  // Es el caso que un `set()` masivo a ciegas pisaría sin avisar. Acá tiene que ABORTAR.
  await dbD.doc(`tenants/${TENANT}/products/p1`).set({ name: 'EDITADO EN EL DESTINO', price: 999 });
  const conConflicto = correr('restore-firestore.mjs', [...argsRestore, '--confirmo', huellaDestino, '--apply'], { esperaFallo: true });
  check('conflictos: un documento divergente en el destino ABORTA el restore en vez de pisarlo',
    conConflicto.code !== 0 && /DIFIEREN del backup/.test(conConflicto.salida));
  check('conflictos: el destino quedó INTACTO tras el aborto (no se escribió nada a medias)',
    (await dbD.doc(`tenants/${TENANT}/products/p1`).get()).data()?.price === 999);

  const conSobrescribir = correr('restore-firestore.mjs', [...argsRestore, '--confirmo', huellaDestino, '--sobrescribir', '--apply']);
  check('conflictos: con `--sobrescribir` explícito sí repone el valor del backup',
    conSobrescribir.code === 0 && (await dbD.doc(`tenants/${TENANT}/products/p1`).get()).data()?.price === 250000);

  // --- Sobrantes: lo que el destino tiene de más NUNCA se borra ---
  await dbD.doc(`tenants/${TENANT}/products/SOBRANTE`).set({ name: 'creado después del backup' });
  const conSobrante = correr('restore-firestore.mjs', [...argsRestore, '--confirmo', huellaDestino, '--apply']);
  check('sobrantes: se informan y quedan INTACTOS (un restore que borra "lo que sobra" es un DROP)',
    conSobrante.code === 0 && /"sobrantesEnDestino":1/.test(conSobrante.salida.replace(/\s/g, ''))
      && (await dbD.doc(`tenants/${TENANT}/products/SOBRANTE`).get()).exists);

  // ---------------------------------------------------------------------
  // 6. Resultado
  // ---------------------------------------------------------------------
  const fallidos = resultados.filter((r) => !r.ok);
  console.log(`\nRESULTADO BACKUP/RESTORE E2E: ${fallidos.length === 0 ? 'TODO OK ✅' : 'HAY FALLOS ❌'} (${resultados.length - fallidos.length}/${resultados.length})`);
  if (fallidos.length) for (const f of fallidos) console.log(`   ❌ ${f.nombre}`);
  console.log(`[e2e] artefactos en ${dirBackup} y ${dirReporte} (fuera del repo; borrarlos al terminar).`);
  process.exit(fallidos.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
