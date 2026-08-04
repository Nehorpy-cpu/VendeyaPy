/**
 * restore-auth.mjs — Restauración de identidad: usuarios, pertenencia al tenant y roles.
 * ======================================================================================
 * Sin esta pieza, un restore de Firestore produce un tenant que existe y al que nadie puede entrar:
 * `firestore.rules` autoriza a partir de los custom claims (`isTenantOwner`, `isTenantManager`), no
 * de los documentos. Reponer los datos y no los claims es reponer un archivo, no un servicio.
 *
 * QUÉ HACE
 *   Crea los usuarios que faltan con **el mismo uid** y actualiza el perfil de los que existen, y en
 *   ambos casos aplica los `customClaims` del backup (tenantId, role y cualquier claim futuro).
 *
 * QUÉ NO HACE
 *   · **No toca producción** (mismos candados que `restore-firestore.mjs`).
 *   · **No borra ni deshabilita usuarios.** Los que existen en el destino y no están en el backup se
 *     informan como sobrantes y quedan intactos.
 *   · **No repone contraseñas**: el backup no guarda hashes a propósito (ver `backup-auth.mjs`). Los
 *     usuarios restaurados conservan uid, perfil y permisos, y tienen que restablecer contraseña.
 *     Está escrito acá, en el manifiesto y en el runbook porque descubrirlo durante un incidente es
 *     exactamente lo que un runbook existe para evitar.
 *
 * USO
 *   node scripts/restore-auth.mjs --project <id> --desde <dir backup> --out <dir reporte>
 *   node scripts/restore-auth.mjs --project <id> --desde <dir> --out <dir> --confirmo <huella> --apply
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  FORMATO, huella, sha256, resolverDestino, AYUDA_DESTINO, validarSalida, AYUDA_SALIDA,
  prepararSalida, leerFlag, esAplicar, tieneFlag, manifiestoBase, RAIZ_REPO,
} from './backup-lib.mjs';
import { proyectarUsuario, hashUsuario, resumirRoles } from './backup-auth.mjs';
import { evaluarDestinoRestore, AYUDA_RESTORE, leerNdjson, verificarManifiesto } from './restore-lib.mjs';
import { aliasDeFirebaserc } from './deploy-guard.mjs';

// ---------------------------------------------------------------------------
// Lógica PURA
// ---------------------------------------------------------------------------

/**
 * Campos de PERFIL que se reponen. Los claims van aparte (`setCustomUserClaims`) porque el Admin
 * SDK los trata como una operación distinta y porque son lo que decide el ACCESO: mezclarlos con el
 * perfil haría que un fallo parcial dejara al usuario creado y sin permisos, que es la peor mitad.
 */
export function perfilRestaurable(u) {
  const out = { uid: u.uid, disabled: Boolean(u.disabled) };
  if (u.email) { out.email = u.email; out.emailVerified = Boolean(u.emailVerified); }
  if (u.phoneNumber) out.phoneNumber = u.phoneNumber;
  if (u.displayName) out.displayName = u.displayName;
  if (u.photoURL) out.photoURL = u.photoURL;
  return out;
}

/** Clasifica cada usuario del backup contra el destino: ausente / idéntico / divergente. */
export function clasificarUsuarios(lineas, actualesPorUid) {
  const ausentes = [];
  const identicos = [];
  const divergentes = [];
  for (const l of lineas) {
    const actual = actualesPorUid.get(l.uid);
    if (!actual) ausentes.push(l.uid);
    else if (hashUsuario(actual) === l.hash) identicos.push(l.uid);
    else divergentes.push(l.uid);
  }
  return { ausentes, identicos, divergentes };
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

async function main(argv, env) {
  const destino = resolverDestino({ env, argv });
  if (!destino.ok) throw new Error(`[restore-auth] ABORTADO (${destino.motivo}): ${AYUDA_DESTINO[destino.motivo]}`);

  const desdeFlag = leerFlag(argv, 'desde');
  if (desdeFlag.ambiguo) throw new Error('[restore-auth] ABORTADO: `--desde` repetido.');
  if (!desdeFlag.valor || !isAbsolute(desdeFlag.valor)) throw new Error('[restore-auth] ABORTADO: falta `--desde <dir absoluto del backup>`.');
  const dirBackup = resolve(desdeFlag.valor);

  const outFlag = leerFlag(argv, 'out');
  if (outFlag.ambiguo) throw new Error('[restore-auth] ABORTADO: `--out` repetido.');
  const salida = validarSalida(outFlag.valor);
  if (!salida.ok) throw new Error(`[restore-auth] ABORTADO (${salida.motivo}): ${AYUDA_SALIDA[salida.motivo]}`);

  const confirmoFlag = leerFlag(argv, 'confirmo');
  if (confirmoFlag.ambiguo) throw new Error('[restore-auth] ABORTADO: `--confirmo` repetido.');
  const aplicar = esAplicar(argv);
  const sobrescribir = tieneFlag(argv, 'sobrescribir');
  const { projectId, esEmulador } = destino;

  const archivoDatos = join(dirBackup, 'auth.ndjson');
  const archivoManifiesto = join(dirBackup, 'manifest-auth.json');
  if (!existsSync(archivoDatos) || !existsSync(archivoManifiesto)) {
    throw new Error(`[restore-auth] ABORTADO: ${dirBackup} no contiene auth.ndjson + manifest-auth.json.`);
  }
  const manifiesto = JSON.parse(readFileSync(archivoManifiesto, 'utf8'));
  const chequeo = verificarManifiesto({ manifiesto, sha256Archivo: sha256(readFileSync(archivoDatos)), formatoEsperado: FORMATO });
  if (!chequeo.ok) throw new Error(`[restore-auth] ABORTADO: ${chequeo.motivo}`);
  const lineas = leerNdjson(archivoDatos);

  const veredicto = evaluarDestinoRestore({
    projectId,
    esEmulador,
    databaseId: '(default)',
    aliases: aliasDeFirebaserc(RAIZ_REPO),
    proyectoAislado: tieneFlag(argv, 'proyecto-aislado'),
    confirmacion: confirmoFlag.valor,
  });
  // Auth no tiene "base con nombre propio": contra un proyecto remoto el aislamiento lo dan el
  // nombre del proyecto y la declaración explícita. Por eso `base_por_defecto` no aplica acá.
  const soloFaltaConfirmar = veredicto.motivo === 'confirmacion_ausente' && !aplicar;
  const noAplicaBase = veredicto.motivo === 'base_por_defecto';
  if (!veredicto.ok && !soloFaltaConfirmar && !noAplicaBase) {
    throw new Error(`[restore-auth] ABORTADO (${veredicto.motivo}): ${AYUDA_RESTORE[veredicto.motivo]}${veredicto.esperada ? ` Huella de este destino: ${veredicto.esperada}` : ''}`);
  }
  const huellaDelDestino = veredicto.huella ?? veredicto.esperada;

  if (!getApps().length) {
    initializeApp(env.GOOGLE_APPLICATION_CREDENTIALS && !esEmulador ? { credential: applicationDefault(), projectId } : { projectId });
  }
  const auth = getAuth();

  console.log(`[restore-auth] destino=${projectId} emulador=${esEmulador} backup#${huella(dirBackup)} modo=${aplicar ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[restore-auth] ${lineas.length} usuarios en el backup · huella del destino: ${huellaDelDestino}`);

  // --- Precondiciones ---
  const actualesPorUid = new Map();
  for (const l of lineas) {
    try { actualesPorUid.set(l.uid, proyectarUsuario(await auth.getUser(l.uid))); } catch { /* ausente */ }
  }
  const conflictos = clasificarUsuarios(lineas, actualesPorUid);
  const resumen = {
    enBackup: lineas.length,
    ausentes: conflictos.ausentes.length,
    identicos: conflictos.identicos.length,
    divergentes: conflictos.divergentes.length,
    roles: resumirRoles(lineas.map((l) => l.usuario)),
  };
  console.log(`[restore-auth] precondiciones: ${JSON.stringify(resumen)}`);

  prepararSalida(salida.path);
  const rutaReporte = join(salida.path, 'restore-auth-reporte.json');
  const reporte = {
    ...manifiestoBase({ herramienta: 'restore-auth', projectId, esEmulador, tenantId: manifiesto.tenantId, aplicado: aplicar }),
    origen: { directorio: dirBackup, sha256: manifiesto.sha256, creadoEn: manifiesto.creadoEn },
    resumen,
    detalle: conflictos,
    politicaDeBorrado: 'Esta herramienta NUNCA borra ni deshabilita usuarios que no estén en el backup.',
    contrasenas: 'El backup no incluye hashes: los usuarios restaurados deben restablecer contraseña. Ver manifest-auth.json.',
  };
  writeFileSync(rutaReporte, `${JSON.stringify(reporte, null, 2)}\n`, { mode: 0o600 });

  if (conflictos.divergentes.length > 0 && !sobrescribir) {
    throw new Error(`[restore-auth] ABORTADO: ${conflictos.divergentes.length} usuario(s) del destino DIFIEREN del backup. Detalle en ${rutaReporte}. Agregá \`--sobrescribir\` para pisarlos.`);
  }
  if (!aplicar) {
    console.log(`[restore-auth] DRY-RUN: nada escrito. Para aplicar: --confirmo ${huellaDelDestino} --apply`);
    return;
  }

  const pendientes = new Set([...conflictos.ausentes, ...conflictos.divergentes]);
  let creados = 0;
  let actualizados = 0;
  for (const l of lineas.filter((x) => pendientes.has(x.uid))) {
    const perfil = perfilRestaurable(l.usuario);
    if (actualesPorUid.has(l.uid)) { await auth.updateUser(l.uid, perfil); actualizados += 1; }
    else { await auth.createUser(perfil); creados += 1; }
    // Los claims SIEMPRE, incluso sobre un perfil ya idéntico: son lo que decide el acceso.
    await auth.setCustomUserClaims(l.uid, l.usuario.customClaims ?? null);
  }

  // --- Verificación posterior: los claims son el punto, así que se releen ---
  const noCoinciden = [];
  for (const l of lineas) {
    const post = proyectarUsuario(await auth.getUser(l.uid));
    if (JSON.stringify(post.customClaims ?? null) !== JSON.stringify(l.usuario.customClaims ?? null)) noCoinciden.push(l.uid);
  }

  reporte.aplicado = true;
  reporte.escritos = { creados, actualizados };
  reporte.verificacionPosterior = { comparados: lineas.length, claimsQueNoCoinciden: noCoinciden.length, detalle: noCoinciden };
  writeFileSync(rutaReporte, `${JSON.stringify(reporte, null, 2)}\n`, { mode: 0o600 });

  if (noCoinciden.length > 0) {
    throw new Error(`[restore-auth] ABORTADO: ${noCoinciden.length} usuario(s) quedaron con claims distintos a los del backup. El tenant restaurado NO tiene la autorización correcta.`);
  }
  console.log(`[restore-auth] OK: ${creados} creados, ${actualizados} actualizados, ${lineas.length} verificados por claims.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
