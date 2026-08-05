/**
 * restore-firestore.mjs — Restauración de Firestore desde un backup, con el destino bajo llave.
 * =============================================================================================
 * Es la mitad que no existía. Hasta hoy el repo tenía (a medias) cómo sacar datos y **ninguna**
 * forma de volver a ponerlos: o sea, no tenía backup — tenía un archivo.
 *
 * QUÉ HACE
 *   Lee el volcado de `backup-firestore.mjs`, verifica que el archivo sea el que su manifiesto dice
 *   (formato + sha256), CONTIENE cada path contra el tenant del manifest (nada del bundle elige
 *   sobre qué documento se escribe — ver `contenerPathsDelBundle`), CLASIFICA cada documento contra
 *   el destino (ausente / idéntico / divergente), reporta los conflictos y recién entonces escribe
 *   — reconstruyendo `Timestamp`, `GeoPoint`, `Bytes` y `DocumentReference` como los tipos que
 *   eran, no como mapas.
 *
 * QUÉ NO HACE, NUNCA
 *   · **No toca producción.** Ver `restore-lib.mjs`: es una negativa, no una confirmación difícil.
 *   · **No borra nada.** Lo que está en el destino y no está en el backup se REPORTA como sobrante
 *     y se deja intacto. Un restore que borra "lo que sobra" es un `DROP` con otro nombre.
 *   · **No sobrescribe por defecto.** Ante documentos divergentes aborta y deja el detalle escrito;
 *     `--sobrescribir` es una decisión explícita del operador.
 *
 * LO QUE UN RESTORE NO PUEDE DESHACER — leerlo antes de creer que "volvimos atrás"
 *   Restaurar Firebase repone documentos. **No deshace nada que ya hizo Meta ni la app WhatsApp
 *   Business del vendedor.** Un restore NO des-onboardea un número: si entró en Coexistence, sigue
 *   onboardeado, y desconectarlo es un acto del cliente desde su teléfono (ADR-0017 §6). Tampoco
 *   repone las políticas TTL, que son configuración de la base. Todo esto viaja en cada manifiesto.
 *
 * USO
 *   node scripts/restore-firestore.mjs --project <id> --desde <dir backup> --out <dir reporte> [--tenant <id>]
 *   node scripts/restore-firestore.mjs --project <id> --desde <dir> --out <dir> --confirmo <huella> --apply
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  FORMATO, huella, sha256, codificar, decodificar, hashDoc, resolverDestino, AYUDA_DESTINO,
  validarSalida, AYUDA_SALIDA, prepararSalida, leerFlag, esAplicar, tieneFlag, manifiestoBase, RAIZ_REPO,
} from './backup-lib.mjs';
import { recorrerColeccion, referenciasDeSecreto } from './backup-firestore.mjs';
import {
  evaluarDestinoRestore, AYUDA_RESTORE, leerNdjson, verificarManifiesto, clasificarConflictos, caminoSano,
} from './restore-lib.mjs';
import { aliasDeFirebaserc } from './deploy-guard.mjs';

/** Firestore acepta 500 escrituras por batch; 400 deja aire para reintentos. */
const TAM_BATCH = 400;

// ---------------------------------------------------------------------------
// Lógica PURA
// ---------------------------------------------------------------------------

/** Documentos del destino que el backup no conoce. NUNCA se borran: se informan. */
export const calcularSobrantes = (pathsDestino, pathsBackup) => {
  const enBackup = new Set(pathsBackup);
  return pathsDestino.filter((p) => !enBackup.has(p)).sort();
};

/** Forma válida del name de un secreto (la misma de `lib/secretStore.ts`: sin '/'). */
const NOMBRE_SECRETO_RE = /^[A-Za-z0-9._-]+$/;

/**
 * CONTENCIÓN de CADA path del volcado contra el tenant del manifest (correctivo release-safety).
 *
 * `db.doc(l.path)` convierte texto del bundle en una ESCRITURA, y un bundle es un archivo en disco
 * cuya procedencia nadie garantiza: sin esta función, un NDJSON adulterado escribía
 * `tenants/{otro}/…`, `secrets/{ajeno}` o cualquier colección global del destino. La regla refleja
 * exactamente el universo que `backup-firestore.mjs` produce — nada más tiene derecho a estar ahí:
 *
 *   · el documento del tenant y TODO su subárbol (`tenants/{t}` / `tenants/{t}/…`);
 *   · `secrets/{name}` SOLO si algún documento contenido lo referencia (`referenciasDeSecreto`,
 *     el mismo criterio con el que el backup los incluyó);
 *   · documentos RAÍZ de colecciones globales cuya data declara `tenantId === t`, y sus subárboles.
 *
 * Todo lo demás —otro tenant, globales sin tenant, estructura rota (traversal, `\`, rutas de
 * colección)— es una violación. Una sola violación aborta el restore entero: un bundle que trae
 * UN path hostil no es un backup con un error, es un bundle en el que no se puede confiar.
 */
export function contenerPathsDelBundle(lineas, tenantId) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return { ok: false, violaciones: (lineas ?? []).map((l) => ({ path: String(l?.path ?? ''), motivo: 'tenant_ausente' })) };
  }
  const docTenant = `tenants/${tenantId}`;
  const prefijo = `${docTenant}/`;
  const esDocSano = (p) => typeof p === 'string' && caminoSano(p) && p.split('/').length % 2 === 0;

  // Pase 1: lo contenido por derecho propio — el subárbol del tenant y las raíces globales que
  // declaran el tenant en su propia data (la MISMA condición con la que el backup las eligió).
  const raicesGlobalesPropias = new Set();
  const contenidas = [];
  for (const l of lineas ?? []) {
    const p = l?.path;
    if (!esDocSano(p)) continue;
    if (p === docTenant || p.startsWith(prefijo)) { contenidas.push(l); continue; }
    const seg = p.split('/');
    if (seg[0] !== 'tenants' && seg[0] !== 'secrets' && seg.length === 2 && l.existe && l.data?.tenantId === tenantId) {
      raicesGlobalesPropias.add(p);
      contenidas.push(l);
    }
  }
  // Los secretos permitidos: los que algún documento contenido referencia.
  const secretosPermitidos = new Set();
  for (const l of contenidas) if (l.existe && l.data) referenciasDeSecreto(l.data, secretosPermitidos);

  // Pase 2: veredicto línea por línea.
  const violaciones = [];
  for (const l of lineas ?? []) {
    const p = l?.path;
    if (typeof p !== 'string' || !caminoSano(p)) { violaciones.push({ path: String(p ?? ''), motivo: 'path_malformado' }); continue; }
    const seg = p.split('/');
    if (seg.length % 2 !== 0) { violaciones.push({ path: p, motivo: 'no_es_un_documento' }); continue; }
    if (p === docTenant || p.startsWith(prefijo)) continue;
    if (seg[0] === 'tenants') { violaciones.push({ path: p, motivo: 'otro_tenant' }); continue; }
    if (seg[0] === 'secrets') {
      if (seg.length === 2 && NOMBRE_SECRETO_RE.test(seg[1]) && secretosPermitidos.has(seg[1])) continue;
      violaciones.push({ path: p, motivo: 'secreto_no_referenciado' });
      continue;
    }
    if (raicesGlobalesPropias.has(seg.slice(0, 2).join('/'))) continue;
    violaciones.push({ path: p, motivo: seg.length === 2 ? 'global_sin_tenant' : 'subarbol_global_sin_raiz_propia' });
  }
  return { ok: violaciones.length === 0, violaciones };
}

/** Reparte las escrituras en batches del tamaño que Firestore admite. */
export function enTandas(items, tam = TAM_BATCH) {
  const out = [];
  for (let i = 0; i < items.length; i += tam) out.push(items.slice(i, i + tam));
  return out;
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

async function main(argv, env) {
  const destino = resolverDestino({ env, argv });
  if (!destino.ok) throw new Error(`[restore-firestore] ABORTADO (${destino.motivo}): ${AYUDA_DESTINO[destino.motivo]}`);

  const desdeFlag = leerFlag(argv, 'desde');
  if (desdeFlag.ambiguo) throw new Error('[restore-firestore] ABORTADO: `--desde` repetido.');
  if (!desdeFlag.valor || !isAbsolute(desdeFlag.valor)) throw new Error('[restore-firestore] ABORTADO: falta `--desde <dir absoluto del backup>`.');
  const dirBackup = resolve(desdeFlag.valor);

  const outFlag = leerFlag(argv, 'out');
  if (outFlag.ambiguo) throw new Error('[restore-firestore] ABORTADO: `--out` repetido.');
  const salida = validarSalida(outFlag.valor);
  if (!salida.ok) throw new Error(`[restore-firestore] ABORTADO (${salida.motivo}): ${AYUDA_SALIDA[salida.motivo]}`);

  const dbFlag = leerFlag(argv, 'database');
  if (dbFlag.ambiguo) throw new Error('[restore-firestore] ABORTADO: `--database` repetido.');
  const databaseId = dbFlag.valor ?? '(default)';
  const confirmoFlag = leerFlag(argv, 'confirmo');
  if (confirmoFlag.ambiguo) throw new Error('[restore-firestore] ABORTADO: `--confirmo` repetido.');

  const aplicar = esAplicar(argv);
  const sobrescribir = tieneFlag(argv, 'sobrescribir');
  const { projectId, esEmulador } = destino;

  // --- Volcado y manifiesto ---
  const archivoDatos = join(dirBackup, 'firestore.ndjson');
  const archivoManifiesto = join(dirBackup, 'manifest-firestore.json');
  if (!existsSync(archivoDatos) || !existsSync(archivoManifiesto)) {
    throw new Error(`[restore-firestore] ABORTADO: ${dirBackup} no contiene firestore.ndjson + manifest-firestore.json.`);
  }
  const manifiesto = JSON.parse(readFileSync(archivoManifiesto, 'utf8'));
  const chequeo = verificarManifiesto({ manifiesto, sha256Archivo: sha256(readFileSync(archivoDatos)), formatoEsperado: FORMATO });
  if (!chequeo.ok) throw new Error(`[restore-firestore] ABORTADO: ${chequeo.motivo}`);
  const lineas = leerNdjson(archivoDatos);

  // --- CONTENCIÓN DE PATHS, SIEMPRE (correctivo release-safety) ---
  // Cada path del volcado se valida contra el tenant del manifest ANTES de convertirse en un
  // `db.doc(...)`: el bundle no elige sobre qué documentos se escribe. `--tenant` es opcional y,
  // si viene, tiene que coincidir — es la verificación humana de a QUIÉN pertenece este backup.
  const tenantDelManifest = typeof manifiesto.tenantId === 'string' && manifiesto.tenantId ? manifiesto.tenantId : null;
  if (!tenantDelManifest) {
    throw new Error('[restore-firestore] ABORTADO: el manifest no declara `tenantId`. Sin tenant no hay contención de paths posible.');
  }
  const tenantFlag = leerFlag(argv, 'tenant');
  if (tenantFlag.ambiguo) throw new Error('[restore-firestore] ABORTADO: `--tenant` repetido. Uno solo, exacto.');
  if (tenantFlag.valor && tenantFlag.valor !== tenantDelManifest) {
    throw new Error(`[restore-firestore] ABORTADO (tenant_no_coincide): --tenant no coincide con el tenant del manifest (#${huella(tenantDelManifest)}).`);
  }
  const contencion = contenerPathsDelBundle(lineas, tenantDelManifest);
  if (!contencion.ok) {
    // El detalle va por HUELLA: los paths completos identifican clientes y esto sale por consola.
    const muestra = contencion.violaciones.slice(0, 5).map((v) => ({ path: huella(v.path), motivo: v.motivo }));
    throw new Error(
      `[restore-firestore] ABORTADO: ${contencion.violaciones.length} path(s) del volcado violan la contención del tenant ` +
        `#${huella(tenantDelManifest)}: ${JSON.stringify(muestra)}. Un bundle con un path hostil no se restaura.`,
    );
  }

  // --- Candados del destino ---
  const veredicto = evaluarDestinoRestore({
    projectId,
    esEmulador,
    databaseId,
    aliases: aliasDeFirebaserc(RAIZ_REPO),
    proyectoAislado: tieneFlag(argv, 'proyecto-aislado'),
    confirmacion: confirmoFlag.valor,
  });
  // En DRY-RUN la falta de confirmación no es un error: el dry-run es justamente cómo se OBTIENE la
  // huella. Cualquier otro motivo —y una confirmación equivocada— aborta siempre.
  const soloFaltaConfirmar = veredicto.motivo === 'confirmacion_ausente' && !aplicar;
  if (!veredicto.ok && !soloFaltaConfirmar) {
    throw new Error(
      `[restore-firestore] ABORTADO (${veredicto.motivo}): ${AYUDA_RESTORE[veredicto.motivo]}` +
        `${veredicto.esperada ? ` Huella de este destino: ${veredicto.esperada}` : ''}`,
    );
  }
  const huellaDelDestino = veredicto.huella ?? veredicto.esperada;

  if (!getApps().length) {
    initializeApp(env.GOOGLE_APPLICATION_CREDENTIALS && !esEmulador ? { credential: applicationDefault(), projectId } : { projectId });
  }
  const db = databaseId === '(default)' ? getFirestore() : getFirestore(getApps()[0], databaseId);

  console.log(`[restore-firestore] destino=${projectId} base=${databaseId} emulador=${esEmulador} backup#${huella(dirBackup)} modo=${aplicar ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[restore-firestore] tenant del backup #${huella(manifiesto.tenantId)} · ${lineas.length} líneas · huella del destino: ${huellaDelDestino}`);

  // --- Precondiciones: estado ACTUAL de cada documento del volcado ---
  const paths = lineas.map((l) => l.path);
  const hashesActuales = new Map();
  for (const tanda of enTandas(paths.map((p) => db.doc(p)), 300)) {
    for (const snap of await db.getAll(...tanda)) {
      if (snap.exists) hashesActuales.set(snap.ref.path, hashDoc(codificar(snap.data() ?? {})));
    }
  }
  const conflictos = clasificarConflictos(lineas, hashesActuales);

  // --- Sobrantes en el destino (se informan, JAMÁS se borran) ---
  const tenantId = manifiesto.tenantId;
  const refsDestino = [];
  if (tenantId) {
    const tRef = db.doc(`tenants/${tenantId}`);
    for (const sub of await tRef.listCollections()) await recorrerColeccion(sub, refsDestino);
  }
  const sobrantes = calcularSobrantes(refsDestino.map((r) => r.path), paths);

  const resumen = {
    lineas: lineas.length,
    aEscribir: conflictos.ausentes.length + conflictos.divergentes.length,
    ausentes: conflictos.ausentes.length,
    identicos: conflictos.identicos.length,
    divergentes: conflictos.divergentes.length,
    sobrantesEnDestino: sobrantes.length,
  };
  console.log(`[restore-firestore] precondiciones: ${JSON.stringify(resumen)}`);

  prepararSalida(salida.path);
  const reporte = {
    ...manifiestoBase({ herramienta: 'restore-firestore', projectId, esEmulador, tenantId, aplicado: aplicar }),
    base: databaseId,
    origen: { directorio: dirBackup, sha256: manifiesto.sha256, creadoEn: manifiesto.creadoEn },
    resumen,
    // El DETALLE (rutas completas, que identifican clientes) va SOLO a este archivo privado.
    detalle: { ...conflictos, sobrantes },
    politicaDeBorrado: 'Esta herramienta NUNCA borra. Los sobrantes quedan intactos en el destino y solo se informan.',
  };
  writeFileSync(join(salida.path, 'restore-firestore-reporte.json'), `${JSON.stringify(reporte, null, 2)}\n`, { mode: 0o600 });

  if (conflictos.divergentes.length > 0 && !sobrescribir) {
    throw new Error(
      `[restore-firestore] ABORTADO: ${conflictos.divergentes.length} documento(s) del destino DIFIEREN del backup. ` +
        `Detalle en ${join(salida.path, 'restore-firestore-reporte.json')}. Agregá \`--sobrescribir\` solo si de verdad querés pisarlos.`,
    );
  }

  if (!aplicar) {
    console.log(`[restore-firestore] DRY-RUN: nada escrito. Para aplicar: --confirmo ${huellaDelDestino} --apply`);
    return;
  }

  // --- Escritura ---
  const pendientes = new Set([...conflictos.ausentes, ...conflictos.divergentes]);
  const aEscribir = lineas.filter((l) => l.existe && pendientes.has(l.path));
  let escritos = 0;
  for (const tanda of enTandas(aEscribir)) {
    const batch = db.batch();
    for (const l of tanda) {
      batch.set(db.doc(l.path), decodificar(l.data, { refFactory: (p) => db.doc(p) }));
    }
    await batch.commit();
    escritos += tanda.length;
  }

  // --- Verificación posterior: releer y comparar hashes ---
  const hashesPost = new Map();
  for (const tanda of enTandas(paths.map((p) => db.doc(p)), 300)) {
    for (const snap of await db.getAll(...tanda)) {
      if (snap.exists) hashesPost.set(snap.ref.path, hashDoc(codificar(snap.data() ?? {})));
    }
  }
  const noCoinciden = lineas.filter((l) => l.existe && hashesPost.get(l.path) !== l.hash).map((l) => l.path);

  reporte.aplicado = true;
  reporte.escritos = escritos;
  reporte.verificacionPosterior = { comparados: lineas.filter((l) => l.existe).length, noCoinciden: noCoinciden.length, detalle: noCoinciden };
  writeFileSync(join(salida.path, 'restore-firestore-reporte.json'), `${JSON.stringify(reporte, null, 2)}\n`, { mode: 0o600 });

  if (noCoinciden.length > 0) {
    throw new Error(`[restore-firestore] ABORTADO: tras escribir, ${noCoinciden.length} documento(s) NO tienen el hash del backup. La restauración NO es fiel; ver el reporte.`);
  }
  console.log(`[restore-firestore] OK: ${escritos} documentos escritos, ${lineas.filter((l) => l.existe).length} verificados por hash. Sobrantes intactos: ${sobrantes.length}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
