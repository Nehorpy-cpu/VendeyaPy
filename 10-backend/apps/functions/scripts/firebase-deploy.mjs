#!/usr/bin/env node
/**
 * firebase-deploy.mjs — ÚNICO camino por el que los scripts de npm invocan `firebase deploy`.
 * =========================================================================================
 * Valida primero (con `deploy-guard.mjs`, la misma lógica que audita el árbol) y recién entonces
 * ejecuta. Si algo no cierra, sale con código 1 SIN haber tocado la red.
 *
 * Cómo ejecuta, y por qué así:
 *   `spawnSync(process.execPath, [<bin de firebase-tools>, ...args], { shell: false })`
 *   · `shell:false` ⇒ los argumentos NO pasan por un intérprete: no hay inyección posible por
 *     comillas, `;`, `&&` ni sustitución de variables.
 *   · invocar el bin con `process.execPath` (el propio node) en vez de `pnpm exec firebase` evita
 *     depender del PATH y funciona igual en Windows y en Linux, sin `.cmd` ni shims.
 *
 * Uso (los argumentos extra los aporta quien llama, y si faltan se falla cerrado):
 *   node apps/functions/scripts/firebase-deploy.mjs --only firestore:rules --project vpw-staging
 *   pnpm deploy:functions -- --only functions:onWebhookInbox,functions:runTenantJob
 *
 * Este helper NO puede desplegar a producción: el guard bloquea el proyecto productivo y su alias.
 * Producción se despliega a mano con el runbook de `docs/HANDOFF.md` §5.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validarArgsDeploy, PROYECTOS_PERMITIDOS } from './deploy-guard.mjs';

const require = createRequire(import.meta.url);

/** `10-backend`, que es donde viven `.firebaserc`, `firebase.json` y `firebase.functions.json`. */
const RAIZ_PNPM = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// pnpm 9 reenvía un `--` literal antes de los argumentos del usuario; sin este shift el helper
// lo vería como un argumento más y el análisis quedaría corrido.
const args = process.argv.slice(2).filter((a) => a !== '--');

if (args.length === 0) {
  console.error(
    '\n[deploy] No se pasó ningún argumento.\n' +
      '  Este helper exige `--only` y `--project` explícitos. Ejemplos:\n' +
      '    pnpm deploy:rules\n' +
      '    pnpm deploy:functions -- --only functions:onWebhookInbox\n',
  );
  process.exit(1);
}

const { ok, errores, plan } = validarArgsDeploy(args);

if (!ok) {
  console.error('\n[deploy] BLOQUEADO — la invocación no es segura:\n');
  for (const e of errores) console.error('  · ' + e);
  console.error(
    `\n  Proyectos permitidos por esta vía: ${PROYECTOS_PERMITIDOS.join(', ')}.\n` +
      '  Producción (vpw-prod-dd6ff) se despliega ÚNICAMENTE a mano: ver docs/HANDOFF.md §5.\n',
  );
  process.exit(1);
}

const resumen = [
  `proyecto=${plan.proyecto}`,
  plan.superficies.length ? `superficies=${plan.superficies.join(',')}` : null,
  plan.funciones.length ? `functions=${plan.funciones.length} (${plan.funciones.join(', ')})` : null,
  plan.config ? `config=${plan.config}` : null,
].filter(Boolean).join(' | ');
console.error(`\n[deploy] Validado: ${resumen}\n`);

let bin;
try {
  bin = require.resolve('firebase-tools/lib/bin/firebase.js');
} catch {
  console.error('[deploy] No se pudo resolver firebase-tools. Corré `pnpm install` primero.');
  process.exit(1);
}

const r = spawnSync(process.execPath, [bin, 'deploy', ...args], {
  cwd: RAIZ_PNPM,
  stdio: 'inherit',
  shell: false,
});

if (r.error) {
  console.error('[deploy] No se pudo ejecutar firebase:', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
