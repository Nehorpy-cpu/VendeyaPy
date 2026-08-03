/**
 * build-deploy.mjs — Prepara un artefacto de deploy AUTÓNOMO para Cloud Functions.
 * ============================================================================
 * Problema original: Cloud Build corre `npm install` sobre el source subido, y el package.json de
 * apps/functions declara `"@vpw/shared": "workspace:*"` (protocolo pnpm) → npm falla con
 * EUNSUPPORTEDPROTOCOL. Solución: generar `apps/functions/.deploy/` con lib + package.json limpio +
 * tarball de @vpw/shared, y desplegar con `firebase.functions.json`, cuyo `functions.source` apunta
 * ahí.
 *
 * UN ARTEFACTO, UN ENTORNO (2026-08-03, RELEASE-SECURITY-AND-RUNBOOK-HARDEN-1)
 * ---------------------------------------------------------------------------
 * Este script copiaba al artefacto CUALQUIER archivo que matcheara `/^\.env(\.|$)/` y no terminara
 * en `.local`. El comentario decía «copiar SOLO las env desplegables (.env, .env.<projectId>)» —
 * pero el código no sabía cuál era el projectId, así que copiaba el de TODOS los entornos. En una
 * máquina que también despliega a staging, eso metía `.env.vpw-staging` —con sus credenciales en
 * texto plano— dentro del bundle de fuentes de PRODUCCIÓN. No cambiaba nada en runtime (firebase
 * solo carga `.env` y `.env.<projectId>`), pero dejaba secretos de un entorno en el bucket de otro.
 *
 * La causa de fondo no era el regex: era que **el empaquetado no sabía a dónde se estaba
 * desplegando**. Un filtro que solo mira la FORMA del nombre no puede distinguir «el env de este
 * deploy» de «el env de otro entorno». Ahora el destino es un dato explícito y obligatorio:
 *
 *   · firebase expone `GCLOUD_PROJECT` al hook `predeploy` (`lib/deploy/lifecycleHooks.js:61`), ya
 *     resuelto de alias por `needProjectId` — o sea que `--project production` llega como
 *     `vpw-prod-dd6ff`. Ése es el ancla en el camino real de deploy.
 *   · `--project <id>` explícito lo pisa, para poder construir e inspeccionar sin desplegar.
 *   · Sin ninguno de los dos, **se aborta**. Un artefacto sin entorno declarado es un artefacto
 *     ambiguo, y la ambigüedad fue exactamente el bug.
 *
 * Y una segunda red, porque la primera ya falló una vez: después de copiar se RELEE el artefacto y
 * se aborta si aparece cualquier `.env*` fuera de la allowlist. Si algún camino futuro vuelve a
 * meter un archivo de otro entorno, el build se cae en vez de subirlo.
 *
 * Modo inspección (`--inspeccionar`): imprime qué env entrarían para un proyecto dado y sale, sin
 * tocar el disco. Sirve para demostrar la separación por entorno sin construir ni desplegar nada.
 *
 * Este módulo es IMPORTABLE: las funciones puras están arriba y los efectos viven en `main()`,
 * detrás del guard de CLI del final (mismo patrón que `deploy-guard.mjs`). Antes no era así, y
 * bastaba importarlo desde un test para que corriera una build entera.
 *
 * Idempotente. Resuelve rutas desde su propia ubicación (cwd-independiente).
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
// Los alias los lee el guard, que ya sabe dónde vive `.firebaserc` y tolera sus dos ubicaciones.
// Reusarlo evita una segunda interpretación del mismo archivo — el mismo error que este arreglo cierra.
import { aliasDeFirebaserc } from './deploy-guard.mjs';

// ---------------------------------------------------------------------------
// Lógica PURA — sin disco, sin red, sin process. Es la que testea deployEnv.test.ts.
// ---------------------------------------------------------------------------

/**
 * Forma válida de un projectId de GCP. Se valida —en vez de confiar— porque con este valor se
 * construye un nombre de archivo: un `../otro` convertiría la allowlist en un camino de escape.
 */
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{3,28}[a-z0-9]$/;

/** ¿El nombre pertenece a la familia `.env`? `.envnot` y `x.env.foo` NO. */
const esArchivoEnv = (f) => /^\.env($|\.)/.test(f);

/**
 * Decide a QUÉ proyecto se está empaquetando. Devuelve `{ok:true, projectId}` o `{ok:false, motivo}`.
 *
 * Un `--project` repetido es un ERROR y no «gana el último»: firebase usa commander y se queda con
 * la última ocurrencia, así que un lector que tome la primera empaqueta el env equivocado. La misma
 * lección que ya está cableada en `deploy-guard.mjs`.
 */
export function resolverProyectoDestino({ env = {}, argv = [] } = {}) {
  const explicitos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') explicitos.push(argv[i + 1]);
    else if (typeof argv[i] === 'string' && argv[i].startsWith('--project=')) explicitos.push(argv[i].slice('--project='.length));
  }
  if (explicitos.length > 1) return { ok: false, motivo: 'proyecto_ambiguo' };

  const crudo = explicitos.length === 1 ? explicitos[0] : env.GCLOUD_PROJECT;
  if (crudo === undefined || crudo === null || crudo === '') return { ok: false, motivo: 'proyecto_ausente' };
  if (typeof crudo !== 'string' || !PROJECT_ID_RE.test(crudo)) return { ok: false, motivo: 'proyecto_invalido' };
  return { ok: true, projectId: crudo };
}

/**
 * Qué archivos `.env` entran al artefacto para `projectId`, y cuáles quedan afuera.
 *
 * ALLOWLIST, no denylist. Entra exactamente lo que firebase-tools va a LEER para este destino
 * (`lib/functions/env.js:149-153`, `findEnvfiles`):
 *   · `.env`                  — base compartida por todos los proyectos;
 *   · `.env.<projectId>`      — el del destino;
 *   · `.env.<alias>`          — SOLO de los alias de `.firebaserc` que resuelven a ESTE projectId.
 *
 * El tercer caso importa aunque hoy no exista ningún archivo así: firebase también carga el env
 * por alias, y una allowlist más angosta lo dejaría afuera EN SILENCIO — cambiaría la configuración
 * desplegada sin que nadie se entere. Un alias que apunta a otro proyecto (p. ej. `staging` cuando
 * se despliega a producción) queda excluido, que es justamente el punto.
 *
 * Todo lo demás se excluye, incluido cualquier `.local` y —la razón de ser de este arreglo— el env
 * de cualquier OTRO entorno.
 *
 * Los excluidos se devuelven para poder LOGUEARLOS: un filtro silencioso es lo que permitió que
 * esto pasara sin que nadie lo notara. Nunca se emite el contenido, solo el nombre.
 */
export function seleccionarEnvsDeploy(archivos, projectId, aliases = {}) {
  const objetivo = `.env.${projectId}`;
  const permitidos = new Set(['.env', objetivo]);
  for (const [alias, destino] of Object.entries(aliases ?? {})) {
    if (String(destino) === projectId) permitidos.add(`.env.${alias}`);
  }
  const envs = archivos.filter(esArchivoEnv);

  if (!envs.includes(objetivo)) {
    return { incluir: [], excluir: envs.slice().sort(), error: 'env_del_proyecto_faltante' };
  }
  const incluir = envs.filter((f) => permitidos.has(f) && !f.endsWith('.local')).sort();
  const excluir = envs.filter((f) => !incluir.includes(f)).sort();
  return { incluir, excluir, error: null };
}

// ---------------------------------------------------------------------------
// Efectos — solo corren cuando el script se invoca como CLI.
// ---------------------------------------------------------------------------

function main(argv, env) {
  const here = dirname(fileURLToPath(import.meta.url)); // apps/functions/scripts
  const functionsDir = resolve(here, '..'); // apps/functions
  const repoRoot = resolve(functionsDir, '..', '..'); // monorepo root
  const sharedDir = resolve(repoRoot, 'packages', 'shared');
  const deployDir = join(functionsDir, '.deploy');

  // 0. destino OBLIGATORIO: sin entorno declarado no se empaqueta nada.
  const destino = resolverProyectoDestino({ env, argv });
  if (!destino.ok) {
    const ayuda = {
      proyecto_ausente:
        'no se pudo determinar el proyecto destino. En un deploy real firebase expone GCLOUD_PROJECT ' +
        'al predeploy; para correrlo a mano pasá `--project <projectId>`.',
      proyecto_ambiguo: 'se pasó `--project` más de una vez. Un artefacto pertenece a UN entorno.',
      proyecto_invalido: 'el projectId no tiene forma válida de proyecto GCP.',
    }[destino.motivo];
    throw new Error(`[build-deploy] ABORTADO (${destino.motivo}): ${ayuda}`);
  }
  const { projectId } = destino;

  // Alias de `.firebaserc` que resuelven a ESTE proyecto: firebase también lee su `.env.<alias>`.
  const seleccion = seleccionarEnvsDeploy(readdirSync(functionsDir), projectId, aliasDeFirebaserc(repoRoot));
  if (seleccion.error === 'env_del_proyecto_faltante') {
    throw new Error(
      `[build-deploy] ABORTADO: falta \`.env.${projectId}\` en ${functionsDir}. ` +
        'Desplegar sin la configuración del entorno destino no es un accidente aceptable.',
    );
  }

  // Modo inspección: reporta la separación por entorno y sale, sin tocar el disco.
  if (argv.includes('--inspeccionar')) {
    console.log(`[build-deploy] proyecto=${projectId}`);
    console.log(`[build-deploy] incluye: ${seleccion.incluir.join(', ')}`);
    console.log(`[build-deploy] excluye: ${seleccion.excluir.join(', ') || '(nada)'}`);
    return;
  }

  const libDir = join(functionsDir, 'lib');
  if (!existsSync(join(libDir, 'index.js'))) {
    throw new Error('[build-deploy] falta lib/index.js — corré la build de functions antes (tsc).');
  }
  if (!existsSync(join(sharedDir, 'dist', 'index.js'))) {
    throw new Error('[build-deploy] falta packages/shared/dist — corré la build de @vpw/shared antes.');
  }

  // 1. limpiar y recrear el directorio de deploy
  rmSync(deployDir, { recursive: true, force: true });
  mkdirSync(deployDir, { recursive: true });

  // 2. copiar la salida compilada (tsc), sin modificar
  cpSync(libDir, join(deployDir, 'lib'), { recursive: true });

  // 3. package.json limpio: deps reales + @vpw/shared como tarball local; sin devDeps ni workspace:*
  const pkg = JSON.parse(readFileSync(join(functionsDir, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies };
  delete deps['@vpw/shared'];
  deps['@vpw/shared'] = 'file:./vpw-shared.tgz';
  writeFileSync(
    join(deployDir, 'package.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: pkg.type, main: pkg.main, engines: pkg.engines, dependencies: deps }, null, 2) + '\n',
  );

  // 4. empaquetar @vpw/shared (incluye dist + exports map) dentro de .deploy
  execSync(`npm pack --pack-destination "${deployDir}"`, { cwd: sharedDir, stdio: 'inherit' });
  const produced = readdirSync(deployDir).find((f) => f.startsWith('vpw-shared') && f.endsWith('.tgz'));
  if (!produced) throw new Error('[build-deploy] npm pack no produjo el tarball de @vpw/shared.');
  renameSync(join(deployDir, produced), join(deployDir, 'vpw-shared.tgz'));

  // 5. copiar ÚNICAMENTE las env del entorno destino (ver docblock).
  for (const f of seleccion.incluir) cpSync(join(functionsDir, f), join(deployDir, f));

  // 6. instalar deps en el artefacto: firebase-tools hace el DISCOVERY local de triggers cargando
  //    el código, y para eso necesita firebase-functions instalado acá. node_modules se ignora en
  //    la subida (alt config) y Cloud Build reinstala en la nube.
  execSync('npm install --no-audit --no-fund', { cwd: deployDir, stdio: 'inherit' });
  //    Quitar el lockfile para que Cloud Build corra `npm install` fresco (idéntico al verificado
  //    local), evitando la rigidez de `npm ci` con lockfiles cross-platform.
  rmSync(join(deployDir, 'package-lock.json'), { force: true });

  // 7. sanity del artefacto
  if (readFileSync(join(deployDir, 'package.json'), 'utf8').includes('workspace:')) {
    throw new Error('[build-deploy] el package.json del artefacto todavía contiene "workspace:".');
  }
  if (!existsSync(join(deployDir, 'node_modules', 'firebase-functions'))) {
    throw new Error('[build-deploy] firebase-functions no quedó instalado en .deploy/node_modules (discovery fallaría).');
  }

  // 8. SEGUNDA RED: releer el artefacto y exigir que no haya sobrevivido ningún env ajeno. La
  //    primera red ya falló una vez; que este build se caiga es infinitamente preferible a subir
  //    credenciales de otro entorno a un bucket que no les corresponde.
  const enArtefacto = readdirSync(deployDir).filter(esArchivoEnv).sort();
  const intrusos = enArtefacto.filter((f) => !seleccion.incluir.includes(f));
  if (intrusos.length) {
    throw new Error(
      `[build-deploy] ABORTADO: el artefacto quedó con env que no pertenecen a ${projectId}: ` +
        `${intrusos.join(', ')}. NO se sube: sería filtrar secretos de otro entorno.`,
    );
  }

  console.log(`[build-deploy] proyecto=${projectId}`);
  console.log(`[build-deploy] env incluidas: ${enArtefacto.join(', ')}`);
  if (seleccion.excluir.length) console.log(`[build-deploy] env EXCLUIDAS (otro entorno o *.local): ${seleccion.excluir.join(', ')}`);
  console.log(`[build-deploy] OK → ${deployDir} (lib + node_modules + tarball @vpw/shared, sin workspace:)`);
}

// Guard de CLI: importar este módulo NO debe construir nada (antes sí lo hacía).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
