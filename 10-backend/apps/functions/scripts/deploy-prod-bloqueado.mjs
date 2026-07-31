#!/usr/bin/env node
/**
 * deploy-prod-bloqueado.mjs — Bloqueo explícito de los atajos de deploy heredados.
 * ==============================================================================
 * Estos scripts existían y eran trampas activas:
 *  · `deploy:prod` de `10-backend/package.json` corría `firebase deploy --project vpw-prod`, es
 *    decir TODAS las superficies sin `--only`, contra un alias que hoy no existe. El día que
 *    alguien "arreglara" el nombre del proyecto, quedaba un deploy completo a producción.
 *  · `deploy` de `apps/functions/package.json` corría `firebase deploy --only functions`: sin
 *    `--project` caía al default `vpw-dev`, y el selector genérico publica TODOS los exports.
 *
 * No se eliminan del `package.json` para que un `pnpm deploy:prod` escrito de memoria no falle con
 * un "script no encontrado" ambiguo, sino con el motivo real y el camino correcto.
 *
 * Este archivo JAMÁS ejecuta Firebase. Solo explica y sale con código 1.
 */

const workspace = process.argv.includes('--workspace');

const cuerpo = workspace
  ? [
      'El script `deploy` de apps/functions está BLOQUEADO.',
      '',
      'Corría `firebase deploy --only functions`, que tiene tres defectos a la vez:',
      '  · sin `--project` cae al default de .firebaserc (hoy `vpw-dev`);',
      '  · `--only functions` genérico publica TODOS los exports, incluidos los `dev*` que',
      '    nunca deben existir en producción;',
      '  · sin `--config firebase.functions.json` no se arma el artefacto autónomo y el deploy',
      '    rompe en Cloud Build por la dependencia `workspace:*`.',
      '',
      'Para STAGING, desde 10-backend y con el selector exacto:',
      '  pnpm deploy:functions -- --only functions:<nombre>,functions:<nombre>',
    ]
  : [
      'El script `deploy:prod` está BLOQUEADO a propósito.',
      '',
      'Corría `firebase deploy --project vpw-prod`: todas las superficies, sin `--only`, contra un',
      'alias que no existe. Un deploy completo a producción no puede depender de un atajo de npm.',
    ];

console.error(
  '\n[deploy] ' +
    cuerpo.join('\n          ') +
    '\n\n          PRODUCCIÓN se despliega ÚNICAMENTE a mano, con el procedimiento auditado de' +
    '\n          docs/HANDOFF.md §5: rules → functions con selector mínimo calculado del grafo' +
    '\n          del cambio → hosting, con `--project vpw-prod-dd6ff` explícito y sin `--force`.\n',
);

process.exit(1);
