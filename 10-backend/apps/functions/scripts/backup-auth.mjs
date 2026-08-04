/**
 * backup-auth.mjs — Backup de Firebase Authentication (usuarios, claims, pertenencia y roles).
 * ============================================================================================
 * POR QUÉ ES PARTE DEL BACKUP Y NO UN EXTRA
 * -----------------------------------------
 * `firestore.rules` decide TODO el acceso del tenant a partir de los custom claims: `isTenantOwner`
 * / `isTenantManager` leen `request.auth.token.tenantId` y `.role`. Un restore que reponga
 * Firestore pero no los claims deja el tenant **inaccesible**: los documentos están, el panel no
 * puede leerlos y el owner no entiende por qué "no se restauró nada". Por eso la identidad es una
 * pieza del backup, no un anexo.
 *
 * QUÉ SE RESPALDA
 *   uid, email (+verificado), teléfono, displayName, estado `disabled`, proveedores, metadata de
 *   creación/último login y **customClaims completos** (tenantId, role y cualquier claim futuro).
 *
 * QUÉ NO SE RESPALDA, Y ES A PROPÓSITO
 *   **Los hashes de contraseña.** Reimportarlos exige además los parámetros del algoritmo del
 *   proyecto (`hash_config` de `firebase auth:export`), que no son datos del usuario sino
 *   configuración del proyecto; guardar el hash sin ellos produce un archivo con material de
 *   credenciales que además no sirve para restaurar. La consecuencia queda escrita en el
 *   manifiesto y en el runbook: **tras un restore los usuarios conservan uid, claims y perfil, y
 *   necesitan restablecer contraseña** — o se complementa con `firebase auth:export`, que sí
 *   incluye hashes y `hash_config` (y que por eso mismo es un archivo con credenciales).
 *
 * SEGURIDAD
 *   Proyecto y tenant obligatorios · DRY-RUN por defecto · salida absoluta fuera del repo ·
 *   manifiesto con conteos y hashes · el log NUNCA imprime email, teléfono ni uid completos (van
 *   por huella) · exit ≠ 0 ante cero usuarios o cualquier fallo.
 *
 * USO
 *   node scripts/backup-auth.mjs --project <id> --tenant <id> --out <dir absoluto> [--apply]
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
  huella, sha256, canonico, resolverDestino, AYUDA_DESTINO, validarSalida, AYUDA_SALIDA,
  prepararSalida, leerFlag, esAplicar, manifiestoBase,
} from './backup-lib.mjs';

// ---------------------------------------------------------------------------
// Lógica PURA
// ---------------------------------------------------------------------------

/**
 * ¿Este usuario pertenece al tenant?
 *
 * Se decide por el CLAIM, que es lo que la autorización lee de verdad. Mirar el documento
 * `users/{uid}` en su lugar respaldaría a quien el panel cree que pertenece, no a quien las Rules
 * dejan entrar — y son cosas que pueden divergir. El documento ya viaja en el backup de Firestore.
 */
export const perteneceAlTenant = (usuario, tenantId) =>
  Boolean(usuario?.customClaims && usuario.customClaims.tenantId === tenantId);

/**
 * Proyección serializable de un usuario. **No incluye `passwordHash` ni `passwordSalt`** (ver
 * cabecera): la exclusión es explícita y no un olvido, por eso se enumera campo por campo en vez
 * de copiar el objeto entero.
 */
export function proyectarUsuario(u) {
  return {
    uid: u.uid,
    email: u.email ?? null,
    emailVerified: Boolean(u.emailVerified),
    phoneNumber: u.phoneNumber ?? null,
    displayName: u.displayName ?? null,
    photoURL: u.photoURL ?? null,
    disabled: Boolean(u.disabled),
    customClaims: u.customClaims ?? null,
    tenantId: u.customClaims?.tenantId ?? null,
    role: u.customClaims?.role ?? null,
    providers: (u.providerData ?? []).map((p) => ({ providerId: p.providerId, uid: p.uid ?? null, email: p.email ?? null })),
    metadata: {
      creationTime: u.metadata?.creationTime ?? null,
      lastSignInTime: u.metadata?.lastSignInTime ?? null,
      lastRefreshTime: u.metadata?.lastRefreshTime ?? null,
    },
  };
}

/** Conteo por rol — sirve para comprobar, tras el restore, que la autorización quedó igual. */
export function resumirRoles(usuarios) {
  const acc = {};
  for (const u of usuarios) {
    const r = u.role ?? '(sin role)';
    acc[r] = (acc[r] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(acc).sort(([a], [b]) => a.localeCompare(b)));
}

/** Hash del usuario proyectado (claves ordenadas): compara identidad + permisos, no el orden. */
export const hashUsuario = (proyectado) => sha256(Buffer.from(canonico(proyectado), 'utf8'));

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

/** Recorre TODOS los usuarios del proyecto paginando; filtra en memoria por claim de tenant. */
export async function listarUsuariosDelTenant(auth, tenantId) {
  const out = [];
  let total = 0;
  let pageToken;
  do {
    const r = await auth.listUsers(1000, pageToken);
    total += r.users.length;
    for (const u of r.users) if (perteneceAlTenant(u, tenantId)) out.push(proyectarUsuario(u));
    pageToken = r.pageToken;
  } while (pageToken);
  return { usuarios: out, totalProyecto: total };
}

async function main(argv, env) {
  const destino = resolverDestino({ env, argv });
  if (!destino.ok) throw new Error(`[backup-auth] ABORTADO (${destino.motivo}): ${AYUDA_DESTINO[destino.motivo]}`);

  const tenantFlag = leerFlag(argv, 'tenant');
  if (tenantFlag.ambiguo) throw new Error('[backup-auth] ABORTADO: `--tenant` repetido.');
  const tenantId = tenantFlag.valor;
  if (!tenantId) throw new Error('[backup-auth] ABORTADO: falta `--tenant <id>`.');

  const outFlag = leerFlag(argv, 'out');
  if (outFlag.ambiguo) throw new Error('[backup-auth] ABORTADO: `--out` repetido.');
  const salida = validarSalida(outFlag.valor);
  if (!salida.ok) throw new Error(`[backup-auth] ABORTADO (${salida.motivo}): ${AYUDA_SALIDA[salida.motivo]}`);

  const aplicar = esAplicar(argv);
  const { projectId, esEmulador } = destino;
  if (!getApps().length) {
    initializeApp(env.GOOGLE_APPLICATION_CREDENTIALS && !esEmulador ? { credential: applicationDefault(), projectId } : { projectId });
  }

  console.log(`[backup-auth] destino=${projectId} emulador=${esEmulador} tenant#${huella(tenantId)} modo=${aplicar ? 'APPLY' : 'DRY-RUN'}`);

  const { usuarios, totalProyecto } = await listarUsuariosDelTenant(getAuth(), tenantId);
  const roles = resumirRoles(usuarios);

  if (usuarios.length === 0) {
    throw new Error(
      `[backup-auth] ABORTADO: cero usuarios con claim tenantId del tenant #${huella(tenantId)} en ${projectId}. ` +
        'Sin claims el tenant restaurado queda INACCESIBLE, así que un resultado vacío no puede salir con éxito.',
    );
  }

  if (!aplicar) {
    console.log(`[backup-auth] DRY-RUN: ${usuarios.length} usuarios del tenant (de ${totalProyecto} del proyecto). Roles: ${JSON.stringify(roles)}`);
    console.log('[backup-auth] nada escrito. Repetir con `--apply`.');
    return;
  }

  prepararSalida(salida.path);
  const archivo = join(salida.path, 'auth.ndjson');
  const hashes = {};
  const lineas = usuarios.map((u) => {
    hashes[u.uid] = hashUsuario(u);
    return JSON.stringify({ uid: u.uid, usuario: u, hash: hashes[u.uid] });
  });
  writeFileSync(archivo, `${lineas.join('\n')}\n`, { mode: 0o600 });

  const manifiesto = {
    ...manifiestoBase({ herramienta: 'backup-auth', projectId, esEmulador, tenantId, aplicado: true }),
    archivo: 'auth.ndjson',
    sha256: sha256(readFileSync(archivo)),
    usuarios: { delTenant: usuarios.length, totalProyecto },
    rolesPorConteo: roles,
    hashesPorUid: hashes,
    limitacionConocida:
      'NO incluye hashes de contraseña ni `hash_config` del proyecto. Tras un restore los usuarios ' +
      'conservan uid, perfil y customClaims, y deben restablecer contraseña. Para conservar las ' +
      'contraseñas hay que complementar con `firebase auth:export` (ese archivo SÍ contiene ' +
      'material de credenciales y se trata como tal).',
  };
  writeFileSync(join(salida.path, 'manifest-auth.json'), `${JSON.stringify(manifiesto, null, 2)}\n`, { mode: 0o600 });

  console.log(`[backup-auth] OK → ${salida.path} (${usuarios.length} usuarios, roles ${JSON.stringify(roles)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
