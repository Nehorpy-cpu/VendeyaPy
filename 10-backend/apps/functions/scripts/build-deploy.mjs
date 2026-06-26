/**
 * build-deploy.mjs — Prepara un artefacto de deploy AUTÓNOMO para Cloud Functions.
 * ============================================================================
 * Problema: Cloud Build corre `npm install` sobre el source subido, y el
 * package.json de apps/functions declara `"@vpw/shared": "workspace:*"`
 * (protocolo pnpm) → npm falla con EUNSUPPORTEDPROTOCOL.
 *
 * Solución (sin tocar el código ni el package.json versionado, para no romper
 * el emulador / dev local que usan el symlink de workspace): generar
 * `apps/functions/.deploy/` con:
 *   - lib/                     (la salida tsc tal cual, sin bundlear → discovery idéntico)
 *   - package.json             (deps limpias; @vpw/shared → file:./vpw-shared.tgz; sin devDeps)
 *   - vpw-shared.tgz           (tarball de @vpw/shared empaquetado, incluye dist + exports map)
 *   - .env.*                   (las env de dotenv que firebase carga del source dir)
 *
 * Luego se despliega con un config alterno (firebase.functions.json) cuyo
 * functions.source apunta a este `.deploy`. Cloud Build instala @vpw/shared
 * desde el tarball (npm entiende file:), y nanoid (su dep) desde el registro.
 *
 * Idempotente. Resuelve rutas desde su propia ubicación (cwd-independiente).
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)); // apps/functions/scripts
const functionsDir = resolve(here, '..'); // apps/functions
const repoRoot = resolve(functionsDir, '..', '..'); // monorepo root
const sharedDir = resolve(repoRoot, 'packages', 'shared');
const deployDir = join(functionsDir, '.deploy');

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
const deployPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  main: pkg.main,
  engines: pkg.engines,
  dependencies: deps,
};
writeFileSync(join(deployDir, 'package.json'), JSON.stringify(deployPkg, null, 2) + '\n');

// 4. empaquetar @vpw/shared (incluye dist + exports map) dentro de .deploy
execSync(`npm pack --pack-destination "${deployDir}"`, { cwd: sharedDir, stdio: 'inherit' });
const produced = readdirSync(deployDir).find((f) => f.startsWith('vpw-shared') && f.endsWith('.tgz'));
if (!produced) throw new Error('[build-deploy] npm pack no produjo el tarball de @vpw/shared.');
renameSync(join(deployDir, produced), join(deployDir, 'vpw-shared.tgz'));

// 5. copiar las env de dotenv (.env / .env.<projectId>) — firebase las carga del source dir
let copiedEnv = 0;
for (const f of readdirSync(functionsDir)) {
  // Copiar SOLO las env desplegables (.env, .env.<projectId>). NUNCA *.local:
  // .env.local es del emulador / del owner y no debe subirse a la nube.
  if (/^\.env(\.|$)/.test(f) && !f.endsWith('.local')) {
    cpSync(join(functionsDir, f), join(deployDir, f));
    copiedEnv++;
  }
}

// 6. instalar deps en el artefacto: firebase-tools hace el DISCOVERY local de triggers
//    cargando el código, y para eso necesita firebase-functions instalado acá. node_modules
//    se ignora en la subida (alt config) y Cloud Build reinstala en la nube.
execSync('npm install --no-audit --no-fund', { cwd: deployDir, stdio: 'inherit' });
//    Quitar el lockfile para que Cloud Build corra `npm install` fresco (idéntico al verificado
//    local), evitando la rigidez de `npm ci` con lockfiles cross-platform.
rmSync(join(deployDir, 'package-lock.json'), { force: true });

// 7. sanity: el package.json del artefacto NO debe contener workspace:, y el SDK debe resolver
const finalPkg = readFileSync(join(deployDir, 'package.json'), 'utf8');
if (finalPkg.includes('workspace:')) {
  throw new Error('[build-deploy] el package.json del artefacto todavía contiene "workspace:".');
}
if (!existsSync(join(deployDir, 'node_modules', 'firebase-functions'))) {
  throw new Error('[build-deploy] firebase-functions no quedó instalado en .deploy/node_modules (discovery fallaría).');
}

console.log(`[build-deploy] OK → ${deployDir} (lib + node_modules + tarball @vpw/shared, ${copiedEnv} .env, sin workspace:)`);
