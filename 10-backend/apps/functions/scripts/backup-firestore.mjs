/**
 * backup-firestore.mjs — Backup RESTAURABLE de Firestore para un tenant.
 * ======================================================================
 * Reemplaza, en su rol de backup, a `export-tenant.mjs` (que queda como export de PORTABILIDAD,
 * parcial y no restaurable — ver su cabecera y `docs/backup-restore.md`).
 *
 * EL DEFECTO DE FONDO QUE CIERRA
 * ------------------------------
 * El exportador enumera 15 nombres de colección a mano. Esa lista es un dato del AUTOR, no del
 * sistema: todo lo que no esté ahí desaparece del backup sin un solo mensaje. Lo que faltaba, en
 * concreto: las **sesiones** y los **mensajes** (subcolecciones de cada customer), los **ítems de
 * pedido**, el **ciphertext de `secrets/`** —sin el cual un restore deja las conexiones Meta
 * muertas— y **`metaExternalIndex`**, que es el ruteo del inbound: sin él, un mensaje que llega al
 * número real no encuentra tenant y se cae antes de empezar.
 *
 * Acá el descubrimiento lo hace el SISTEMA:
 *   1. `tenants/{tenantId}` y TODO su subárbol, con `listCollections()` sobre la colección y sobre
 *      CADA documento, recursivamente. No hay lista de nombres en ningún lado.
 *   2. Toda OTRA colección raíz (también descubierta con `listCollections()`) se consulta por
 *      `tenantId == <tenant>`. Así entran `metaExternalIndex`, `users` y cualquier índice global
 *      futuro, sin tocar este archivo.
 *   3. Los secretos se resuelven por REFERENCIA: se recolectan las `secret://firestore/<name>` que
 *      aparezcan en los documentos ya volcados y se respalda `secrets/<name>`. Se guarda el
 *      **ciphertext**; nunca se descifra ni se imprime nada.
 *
 * Y se respalda con `listDocuments()`, no con `.get()`: un documento que NO existe pero tiene
 * subcolecciones (padre fantasma) es invisible para `.get()` y perfectamente real para el ruteo de
 * datos. Se registra con `existe:false` para que el restore reconstruya la estructura sin inventar
 * un documento que nunca existió.
 *
 * SEGURIDAD
 * ---------
 * Proyecto y tenant obligatorios · DRY-RUN por defecto (recorre y cuenta; NO escribe) · salida
 * absoluta, fuera del repo y con permisos restringidos · manifiesto con conteos y hashes · logs por
 * huella, sin PII ni secretos · exit ≠ 0 ante cualquier fallo o resultado vacío.
 *
 * USO
 *   node scripts/backup-firestore.mjs --project <id> --tenant <id> --out <dir absoluto>
 *   node scripts/backup-firestore.mjs --project <id> --tenant <id> --out <dir absoluto> --apply
 *
 * Módulo IMPORTABLE: la lógica pura vive arriba, los efectos en `main()` detrás del guard de CLI.
 */
import { createWriteStream, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  FORMATO, huella, sha256, codificar, hashDoc, resolverDestino, AYUDA_DESTINO,
  validarSalida, AYUDA_SALIDA, prepararSalida, leerFlag, esAplicar, manifiestoBase,
} from './backup-lib.mjs';

/** Prefijo de las referencias opacas del almacén de secretos (`lib/secretStore.ts`). */
const PREFIJO_SECRETO = 'secret://firestore/';

// ---------------------------------------------------------------------------
// Lógica PURA
// ---------------------------------------------------------------------------

/**
 * Recolecta los NOMBRES de secreto referenciados por un documento ya codificado.
 *
 * Es una búsqueda por FORMA del valor, no por nombre de campo: `tokenSecretRef` es el caso de hoy,
 * pero cualquier campo futuro que guarde una referencia queda cubierto sin tocar este archivo. Ese
 * es exactamente el error que el exportador cometía al enumerar colecciones a mano.
 */
export function referenciasDeSecreto(valor, acc = new Set()) {
  if (typeof valor === 'string') {
    if (valor.startsWith(PREFIJO_SECRETO)) acc.add(valor.slice(PREFIJO_SECRETO.length));
    return acc;
  }
  if (Array.isArray(valor)) { for (const v of valor) referenciasDeSecreto(v, acc); return acc; }
  if (valor && typeof valor === 'object') { for (const v of Object.values(valor)) referenciasDeSecreto(v, acc); return acc; }
  return acc;
}

/** Línea NDJSON de un documento. Formato estable: lo lee `restore-firestore.mjs`. */
export const lineaDoc = ({ path, existe, data }) => {
  const encoded = existe ? codificar(data ?? {}) : null;
  return { path, existe, data: encoded, hash: existe ? hashDoc(encoded) : null };
};

/** Resumen de conteos por colección, ordenado, para el manifiesto y la comparación post-restore. */
export function resumirPorColeccion(paths) {
  const acc = {};
  for (const p of paths) {
    const partes = p.split('/');
    // Ruta de colección = la ruta sin el id del documento final.
    const col = partes.slice(0, -1).join('/');
    acc[col] = (acc[col] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(acc).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Recorrido (efectos de LECTURA)
// ---------------------------------------------------------------------------

/**
 * Recorre recursivamente un subárbol y devuelve TODAS las referencias de documento.
 *
 * `listDocuments()` —y no `.get()`— es la diferencia entre respaldar la base y respaldar lo que el
 * autor recordaba. Devuelve también los padres fantasma, que son los que cuelgan subcolecciones.
 */
export async function recorrerColeccion(colRef, acc = []) {
  const docs = await colRef.listDocuments();
  for (const docRef of docs) {
    acc.push(docRef);
    for (const sub of await docRef.listCollections()) await recorrerColeccion(sub, acc);
  }
  return acc;
}

/** Lee los datos de N refs en tandas (`getAll` tiene límite práctico por request). */
async function leerEnTandas(db, refs, tam = 300) {
  const out = [];
  for (let i = 0; i < refs.length; i += tam) {
    const snaps = await db.getAll(...refs.slice(i, i + tam));
    for (const s of snaps) out.push({ path: s.ref.path, existe: s.exists, data: s.exists ? s.data() : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

async function main(argv, env) {
  const destino = resolverDestino({ env, argv });
  if (!destino.ok) throw new Error(`[backup-firestore] ABORTADO (${destino.motivo}): ${AYUDA_DESTINO[destino.motivo]}`);

  const tenantFlag = leerFlag(argv, 'tenant');
  if (tenantFlag.ambiguo) throw new Error('[backup-firestore] ABORTADO: `--tenant` repetido. Un backup pertenece a UN tenant.');
  const tenantId = tenantFlag.valor;
  if (!tenantId) throw new Error('[backup-firestore] ABORTADO: falta `--tenant <id>`. No hay tenant por defecto: asumir uno fue el defecto del exportador.');

  const outFlag = leerFlag(argv, 'out');
  if (outFlag.ambiguo) throw new Error('[backup-firestore] ABORTADO: `--out` repetido.');
  const salida = validarSalida(outFlag.valor);
  if (!salida.ok) throw new Error(`[backup-firestore] ABORTADO (${salida.motivo}): ${AYUDA_SALIDA[salida.motivo]}`);

  const aplicar = esAplicar(argv);
  const { projectId, esEmulador } = destino;

  if (!getApps().length) {
    initializeApp(env.GOOGLE_APPLICATION_CREDENTIALS && !esEmulador ? { credential: applicationDefault(), projectId } : { projectId });
  }
  const db = getFirestore();

  console.log(`[backup-firestore] destino=${projectId} emulador=${esEmulador} tenant#${huella(tenantId)} modo=${aplicar ? 'APPLY' : 'DRY-RUN'}`);

  // --- 1. Subárbol del tenant, descubierto por el sistema ---
  const tenantRef = db.doc(`tenants/${tenantId}`);
  const tenantSnap = await tenantRef.get();
  const subcolecciones = await tenantRef.listCollections();
  if (!tenantSnap.exists && subcolecciones.length === 0) {
    throw new Error(`[backup-firestore] ABORTADO: el tenant #${huella(tenantId)} no existe en ${projectId} (ni documento ni subcolecciones). Un backup de la nada no es un backup.`);
  }
  const refs = [tenantRef];
  for (const sub of subcolecciones) await recorrerColeccion(sub, refs);

  // --- 2. Colecciones raíz: lo que declare pertenecer a este tenant ---
  const raices = await db.listCollections();
  const globalesPorTenant = {};
  for (const col of raices) {
    if (col.id === 'tenants') continue;
    const snap = await col.where('tenantId', '==', tenantId).get();
    if (snap.empty) continue;
    globalesPorTenant[col.id] = snap.size;
    for (const d of snap.docs) {
      refs.push(d.ref);
      for (const sub of await d.ref.listCollections()) await recorrerColeccion(sub, refs);
    }
  }

  // --- 3. Datos ---
  const documentos = aplicar ? await leerEnTandas(db, refs) : refs.map((r) => ({ path: r.path, existe: null, data: null }));

  // --- 4. Secretos POR REFERENCIA (ciphertext; jamás plaintext) ---
  const nombresSecreto = new Set();
  if (aplicar) for (const d of documentos) if (d.existe) referenciasDeSecreto(codificar(d.data ?? {}), nombresSecreto);
  const docsSecreto = [];
  for (const nombre of [...nombresSecreto].sort()) {
    const s = await db.doc(`secrets/${nombre}`).get();
    docsSecreto.push({ path: `secrets/${nombre}`, existe: s.exists, data: s.exists ? s.data() : null });
  }
  const secretosFaltantes = docsSecreto.filter((d) => !d.existe).length;

  const todos = [...documentos, ...docsSecreto];
  const conteos = resumirPorColeccion(todos.map((d) => d.path));

  if (!aplicar) {
    console.log(`[backup-firestore] DRY-RUN: ${refs.length} documentos alcanzables en ${Object.keys(conteos).length} colecciones.`);
    console.log('[backup-firestore] colecciones globales con este tenant:', JSON.stringify(globalesPorTenant));
    console.log('[backup-firestore] nada escrito. Repetir con `--apply` para materializar el backup.');
    return;
  }

  // --- 5. Escritura ---
  prepararSalida(salida.path);
  const archivoDatos = join(salida.path, 'firestore.ndjson');
  const stream = createWriteStream(archivoDatos, { encoding: 'utf8', mode: 0o600 });
  const hashes = {};
  let existentes = 0;
  let fantasmas = 0;
  for (const d of todos) {
    const linea = lineaDoc(d);
    if (linea.existe) { existentes += 1; hashes[linea.path] = linea.hash; } else fantasmas += 1;
    stream.write(`${JSON.stringify(linea)}\n`);
  }
  await new Promise((ok, err) => { stream.on('error', err); stream.end(ok); });

  const { readFileSync } = await import('node:fs');
  const hashArchivo = sha256(readFileSync(archivoDatos));

  const manifiesto = {
    ...manifiestoBase({ herramienta: 'backup-firestore', projectId, esEmulador, tenantId, aplicado: true }),
    archivo: 'firestore.ndjson',
    sha256: hashArchivo,
    documentos: { total: todos.length, existentes, fantasmas },
    conteosPorColeccion: conteos,
    coleccionesGlobalesConEsteTenant: globalesPorTenant,
    secretos: { referenciados: nombresSecreto.size, faltantes: secretosFaltantes, contenido: 'ciphertext' },
    hashesPorDocumento: hashes,
  };
  writeFileSync(join(salida.path, 'manifest-firestore.json'), `${JSON.stringify(manifiesto, null, 2)}\n`, { mode: 0o600 });

  if (existentes === 0) {
    throw new Error('[backup-firestore] ABORTADO: cero documentos existentes. Un backup vacío que sale con éxito es el peor resultado posible.');
  }
  if (secretosFaltantes > 0) {
    // No es fatal —puede haber referencias colgadas— pero el operador tiene que saberlo ANTES de
    // creer que un restore va a dejar las conexiones vivas.
    console.warn(`[backup-firestore] ATENCIÓN: ${secretosFaltantes} referencia(s) de secreto sin documento. Un restore dejaría esas conexiones sin credencial.`);
  }
  console.log(`[backup-firestore] OK → ${salida.path} (${existentes} documentos, ${fantasmas} padres fantasma, ${nombresSecreto.size} secretos, sha256=${hashArchivo.slice(0, 16)}…)`);
}

// Guard de CLI: importar este módulo NO ejecuta ningún backup.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

export { FORMATO };
