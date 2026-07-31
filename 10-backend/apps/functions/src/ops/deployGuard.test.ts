/**
 * deployGuard.test.ts — Tests discriminantes del guard de rutas de deploy (DEPLOY-TOOLING-FAIL-CLOSED-1).
 *
 * Cada uno de los defectos que el programa pide bloquear tiene acá un caso ROJO (debe detectarse)
 * y, donde corresponde, su contraparte VERDE (una invocación legítima que NO debe marcarse). Los
 * casos rojos están calcados de lo que el repo tenía realmente antes del fix, más las variantes
 * equivalentes con las que un verificador basado en `grep` se dejaría engañar.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// El guard es .mjs a propósito: lo consumen tanto el CLI del workflow como estos tests, sin build.
// @ts-expect-error — módulo JS sin tipos; el tsconfig excluye los tests del typecheck.
import * as guard from '../../scripts/deploy-guard.mjs';

const { validarArgsDeploy, auditarWorkflow, auditarPackageJson, auditarFirebaseJson, auditarFirebaserc, auditarScript, extraerComandosDeploy, sinComentarios, auditarArbol, raizRepo, descubrirArchivos } = guard as {
  validarArgsDeploy: (argv: string[], o?: { aliases?: Record<string,string> | null }) => { ok: boolean; errores: string[]; plan: Record<string, unknown> };
  auditarWorkflow: (a: string, t: string) => Array<{ severidad: string; titulo: string }>;
  auditarPackageJson: (a: string, t: string) => Array<{ severidad: string; titulo: string }>;
  auditarFirebaseJson: (a: string, t: string) => Array<{ severidad: string; titulo: string }>;
  auditarFirebaserc: (a: string, t: string) => Array<{ severidad: string; titulo: string }>;
  auditarScript: (a: string, t: string) => Array<{ severidad: string; titulo: string }>;
  extraerComandosDeploy: (t: string) => string[];
  sinComentarios: (t: string) => string;
  auditarArbol: (raiz: string) => Array<{ severidad: string; archivo: string; titulo: string }>;
  raizRepo: () => string;
  descubrirArchivos: (raiz: string) => { workflows: string[]; packages: string[]; firebaseJson: string[]; scripts: string[] };
};

const errores = (argv: string[]) => validarArgsDeploy(argv).errores.join(' || ');
const ok = (argv: string[]) => validarArgsDeploy(argv).ok;

// Invocación legítima de referencia: proyecto y superficies explícitos, sin Functions.
const LEGITIMA = ['--only', 'firestore:rules,storage', '--project', 'vpw-staging'];
// Invocación legítima de Functions: selector exacto + config alterno.
const LEGITIMA_FN = ['--only', 'functions:onWebhookInbox,functions:runTenantJob', '--project', 'vpw-staging', '--config', 'firebase.functions.json'];

describe('validarArgsDeploy — casos legítimos (VERDE)', () => {
  it('acepta superficies explícitas con proyecto permitido', () => {
    expect(ok(LEGITIMA)).toBe(true);
  });

  it('acepta Functions con selector exacto y el config alterno', () => {
    const r = validarArgsDeploy(LEGITIMA_FN);
    expect(r.ok).toBe(true);
    expect(r.plan.funciones).toEqual(['onWebhookInbox', 'runTenantJob']);
    expect(r.plan.soloFunciones).toBe(true);
  });

  it('acepta las formas `--flag=valor` y `-P` sin cambiar el veredicto', () => {
    expect(ok(['--only=firestore:rules', '--project=vpw-staging'])).toBe(true);
    expect(ok(['--only', 'firestore:rules', '-P', 'vpw-dev'])).toBe(true);
  });
});

describe('validarArgsDeploy — los 11 defectos que el programa exige bloquear (ROJO)', () => {
  it('1. destino de producción: por project-id y por alias, en todas las formas del flag', () => {
    for (const argv of [
      ['--only', 'firestore:rules', '--project', 'vpw-prod-dd6ff'],
      ['--only', 'firestore:rules', '--project', 'production'],
      ['--only', 'firestore:rules', '--project=vpw-prod-dd6ff'],
      ['--only', 'firestore:rules', '-P', 'production'],
      ['--only', 'firestore:rules', '-Pvpw-prod-dd6ff'], // forma pegada
    ]) {
      expect(errores(argv), argv.join(' ')).toMatch(/PRODUCCIÓN bloqueado/);
    }
  });

  it('2. `--force` está prohibido, también en su forma corta', () => {
    expect(errores([...LEGITIMA, '--force'])).toMatch(/--force.*prohibido/);
    expect(errores([...LEGITIMA, '-f'])).toMatch(/--force.*prohibido/);
  });

  it('3. falta `--project`: el destino queda a merced del default de .firebaserc', () => {
    expect(errores(['--only', 'firestore:rules'])).toMatch(/Falta `--project` explícito/);
  });

  it('4. falta `--only`: un deploy sin superficies despliega TODO', () => {
    expect(errores(['--project', 'vpw-staging'])).toMatch(/Falta `--only`/);
  });

  it('5. `--only functions` genérico (con y sin `=`)', () => {
    expect(errores(['--only', 'functions', '--project', 'vpw-staging', '--config', 'firebase.functions.json']))
      .toMatch(/genérico está prohibido/);
    expect(errores(['--only=functions', '--project=vpw-staging', '--config=firebase.functions.json']))
      .toMatch(/genérico está prohibido/);
  });

  it('6. selector de función vacío — el caso que en firebase deshabilita el filtro en silencio', () => {
    expect(errores(['--only', 'functions:', '--project', 'vpw-staging', '--config', 'firebase.functions.json']))
      .toMatch(/Selector de función vacío/);
  });

  it('7. nombre de función inválido (espacios, separadores, metacaracteres)', () => {
    // `functions:a-b` NO está acá a propósito: el guion es válido en el nombre de un codebase y
    // rechazarlo empujaba al operador a usar `firebase` crudo, fuera del guard. Ver el caso verde.
    for (const mal of ['functions:a b', 'functions:a;rm', 'functions:1x', 'functions:-x']) {
      expect(errores(['--only', mal, '--project', 'vpw-staging', '--config', 'firebase.functions.json']), mal)
        .toMatch(/inválido|metacaracteres/);
    }
  });

  it('8. Functions sin `--config firebase.functions.json`, o con el config equivocado', () => {
    expect(errores(['--only', 'functions:foo', '--project', 'vpw-staging']))
      .toMatch(/Falta `--config firebase\.functions\.json`/);
    expect(errores(['--only', 'functions:foo', '--project', 'vpw-staging', '--config', 'firebase.json']))
      .toMatch(/Config incorrecto para Functions/);
  });

  it('9. mezclar Functions con otras superficies en una sola invocación', () => {
    expect(errores(['--only', 'functions:foo,hosting', '--project', 'vpw-staging', '--config', 'firebase.functions.json']))
      .toMatch(/No se pueden mezclar Functions con otras superficies/);
  });

  it('10. usar el config de Functions para superficies que ese config no declara', () => {
    expect(errores(['--only', 'hosting', '--project', 'vpw-staging', '--config', 'firebase.functions.json']))
      .toMatch(/no declara firestore\/storage\/hosting/);
  });

  it('11. proyecto inexistente o no permitido para una ruta automatizada', () => {
    expect(errores(['--only', 'firestore:rules', '--project', 'vpw-prod'])).toMatch(/no permitido/);
    expect(errores(['--only', 'firestore:rules', '--project', 'proyecto inventado'])).toMatch(/inválido|metacaracteres/);
  });

  it('12. argumentos con metacaracteres de shell (inyección)', () => {
    expect(errores(['--only', 'firestore:rules', '--project', 'vpw-staging; rm -rf /'])).toMatch(/metacaracteres/);
    expect(errores(['--only', 'firestore:rules', '--project', '$(whoami)'])).toMatch(/metacaracteres/);
  });
});

describe('extraerComandosDeploy — variantes que un grep ingenuo dejaría pasar', () => {
  it('reconoce las formas de invocación usadas en el repo y las equivalentes', () => {
    const texto = [
      'firebase deploy --only hosting --project vpw-staging',
      'pnpm exec firebase deploy --only hosting --project vpw-staging',
      'npx firebase deploy --only hosting --project vpw-staging',
      'node ./node_modules/.bin/firebase.js deploy --only hosting --project vpw-staging',
    ].join('\n');
    expect(extraerComandosDeploy(texto)).toHaveLength(4);
  });

  it('une las continuaciones de línea: un comando partido con `\\` sigue siendo UN comando', () => {
    const cmds = extraerComandosDeploy('firebase deploy \\\n  --only functions \\\n  --project production\n');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('--only functions');
    expect(cmds[0]).toContain('--project production');
  });

  it('la forma `args:` de una acción de terceros se audita por el camino del workflow', () => {
    // Acá el binario es IMPLÍCITO (lo aporta la acción), así que solo `auditarWorkflow` puede
    // reconocerla: sin ese contexto, `args: deploy …` es indistinguible de texto cualquiera.
    // Es la forma exacta que usaba el workflow anidado de 10-backend, con `--force` y a producción.
    const yaml = '      - uses: w9jds/firebase-action@master\n        with:\n          args: deploy --project vpw-prod --force\n';
    const hs = auditarWorkflow('w.yml', yaml);
    expect(hs.some((h) => /--force/.test(h.titulo))).toBe(true);
    expect(hs.some((h) => /no permitido/.test(h.titulo))).toBe(true);
  });
});

describe('sinComentarios — no marcar como ejecutable lo que es documentación', () => {
  it('un comentario que MENCIONA producción no es un hallazgo', () => {
    const yaml = '# Producción se despliega a mano con --project vpw-prod-dd6ff\njobs:\n  x:\n    runs-on: ubuntu-latest\n';
    expect(sinComentarios(yaml)).not.toContain('vpw-prod-dd6ff');
    expect(auditarWorkflow('w.yml', yaml)).toHaveLength(0);
  });

  it('pero la MISMA referencia fuera de un comentario sí lo es', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - run: firebase deploy --only hosting --project vpw-prod-dd6ff\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => h.severidad === 'CRITICO')).toBe(true);
  });
});

describe('auditarWorkflow — reglas propias del workflow', () => {
  it('marca la opción `production` de un input choice', () => {
    const yaml = 'on:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: choice\n        options:\n          - staging\n          - production\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => /ofrece `production`/.test(h.titulo))).toBe(true);
  });

  it('marca la interpolación de una expresión dentro de un `run:`', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - run: |\n          firebase deploy --only hosting --project ${{ github.event.inputs.target }}\n';
    const hs = auditarWorkflow('w.yml', yaml);
    expect(hs.some((h) => /interpolada dentro de un `run:`/.test(h.titulo))).toBe(true);
    expect(hs.some((h) => /viene de una variable o expresión/.test(h.titulo))).toBe(true);
  });

  it('marca un destino que llega por variable de shell', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - run: firebase deploy --only hosting --project $TARGET\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => /variable o expresión/.test(h.titulo))).toBe(true);
  });
});

describe('auditarPackageJson', () => {
  it('marca los scripts inseguros y deja pasar los seguros', () => {
    const pkg = JSON.stringify({
      scripts: {
        'deploy:malo': 'firebase deploy --only functions',
        'deploy:bueno': 'node apps/functions/scripts/firebase-deploy.mjs --only firestore:rules --project vpw-staging',
        emulators: 'firebase emulators:start',
        logs: 'firebase functions:log',
      },
    });
    const hs = auditarPackageJson('p.json', pkg);
    expect(hs.every((h) => h.titulo.startsWith('script `deploy:malo`'))).toBe(true);
    expect(hs.length).toBeGreaterThan(0);
  });

  it('no confunde comandos de emulador o de logs con rutas de deploy', () => {
    const pkg = JSON.stringify({ scripts: { serve: 'firebase emulators:start --only functions' } });
    expect(auditarPackageJson('p.json', pkg)).toHaveLength(0);
  });
});

describe('flags repetidos — el bypass que un revisor adversarial demostró', () => {
  // firebase usa commander, que se queda con la ÚLTIMA ocurrencia de un flag. Un validador que
  // mirara la primera aprobaba `--project vpw-staging --project vpw-prod-dd6ff` y desplegaba a
  // producción. Estos casos son exactamente el vector reportado.
  it('un segundo `--project` no puede cambiar el destino sin que se note', () => {
    for (const argv of [
      [...LEGITIMA, '--project', 'vpw-prod-dd6ff'],
      [...LEGITIMA, '--project=vpw-prod-dd6ff'],
      [...LEGITIMA, '-Pvpw-prod-dd6ff'],
      [...LEGITIMA, '-P', 'vpw-prod-dd6ff'],
    ]) {
      expect(errores(argv), argv.join(' ')).toMatch(/Flag repetido: `--project`/);
      expect(ok(argv)).toBe(false);
    }
  });

  it('un segundo `--only` tampoco puede ampliar el alcance', () => {
    expect(errores([...LEGITIMA, '--only', 'functions'])).toMatch(/Flag repetido: `--only`/);
  });

  it('un segundo `--config` tampoco puede cambiar el config de Functions', () => {
    expect(errores([...LEGITIMA_FN, '--config', 'firebase.json'])).toMatch(/Flag repetido: `--config`/);
  });
});

describe('evasiones del verificador estático', () => {
  it('escalar plegado `>`: un `--force` en la línea siguiente sigue siendo del mismo comando', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - run: >\n          firebase deploy --only firestore:rules --project vpw-staging\n          --force\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => /--force/.test(h.titulo))).toBe(true);
  });

  it('`args:` multilínea de una acción de terceros', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - uses: w9jds/firebase-action@master\n        with:\n          args: |\n            deploy --project vpw-prod-dd6ff --force\n';
    const hs = auditarWorkflow('w.yml', yaml);
    expect(hs.some((h) => h.severidad === 'CRITICO')).toBe(true);
    expect(hs.some((h) => /--force/.test(h.titulo))).toBe(true);
  });

  it('binario que no se llama exactamente `firebase` (`npx firebase-tools deploy`)', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - run: npx firebase-tools deploy --project vpw-prod-dd6ff --force\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => h.severidad === 'CRITICO')).toBe(true);
  });

  it('comillas en medio del comando no truncan el análisis', () => {
    const yaml = `jobs:\n  x:\n    steps:\n      - run: firebase deploy --only firestore:rules --project vpw-staging '' --project vpw-prod-dd6ff\n`;
    expect(auditarWorkflow('w.yml', yaml).some((h) => /Flag repetido/.test(h.titulo))).toBe(true);
  });

  it('hooks `predeploy` de un firebase*.json son una ruta ejecutable más', () => {
    const json = JSON.stringify({ firestore: { predeploy: ['firebase deploy --only functions --project vpw-prod-dd6ff'] } });
    const hs = auditarFirebaseJson('firebase.json', json);
    expect(hs.some((h) => h.severidad === 'CRITICO')).toBe(true);
    expect(hs.some((h) => /predeploy/.test(h.titulo))).toBe(true);
  });

  it('un comando escondido dentro de `execSync` en un .mjs', () => {
    const src = "import {execSync} from 'node:child_process';\nexecSync('firebase deploy --only functions --project vpw-prod-dd6ff');\n";
    expect(auditarScript('x.mjs', src).some((h) => h.severidad === 'CRITICO')).toBe(true);
  });

  it('pero un texto que solo se IMPRIME es documentación, no una invocación', () => {
    const src = "console.error('Antes corria: firebase deploy --only functions --project vpw-prod');\n";
    expect(auditarScript('x.mjs', src)).toHaveLength(0);
  });

  it('en un script de shell el texto SÍ es el comando', () => {
    expect(auditarScript('d.sh', 'firebase deploy --only functions --project vpw-prod-dd6ff --force').some((h) => h.severidad === 'CRITICO')).toBe(true);
    expect(auditarScript('d.sh', 'firebase deploy --only firestore:rules --project vpw-staging')).toHaveLength(0);
  });

  it('`firebase use` a producción cambia el destino por defecto de todo lo que siga', () => {
    expect(auditarScript('x.sh', 'firebase use production').some((h) => h.severidad === 'CRITICO')).toBe(true);
  });
});

describe('el alias NO es el destino — firebase re-mapea `--project` contra .firebaserc', () => {
  // Un revisor adversarial demostró que una allowlist que compara el LITERAL aprueba
  // `--project vpw-staging` aunque ese alias apunte al proyecto productivo. Lo que hay que
  // validar es el destino EFECTIVO, y el mapa que lo decide es parte de lo auditado.
  const ENVENENADO = { 'vpw-staging': 'vpw-prod-dd6ff' };

  it('un alias permitido que resuelve a producción queda bloqueado', () => {
    const r = validarArgsDeploy(['--only', 'firestore:rules', '--project', 'vpw-staging'], { aliases: ENVENENADO });
    expect(r.ok).toBe(false);
    expect(r.errores.join(' ')).toMatch(/PRODUCCIÓN bloqueado \(vpw-staging → vpw-prod-dd6ff\)/);
  });

  it('sin mapa envenenado, el mismo comando es legítimo', () => {
    expect(validarArgsDeploy(['--only', 'firestore:rules', '--project', 'vpw-staging'], { aliases: { 'vpw-staging': 'vpw-staging' } }).ok).toBe(true);
  });

  it('un `.firebaserc` con un alias hacia producción es un hallazgo por sí solo', () => {
    expect(auditarFirebaserc('.firebaserc', JSON.stringify({ projects: { staging: 'vpw-prod-dd6ff' } })).some((h) => h.severidad === 'CRITICO')).toBe(true);
    expect(auditarFirebaserc('.firebaserc', JSON.stringify({ projects: { default: 'vpw-prod-dd6ff' } })).some((h) => h.severidad === 'CRITICO')).toBe(true);
  });

  it('el alias `production` documentado del procedimiento manual NO es un hallazgo', () => {
    expect(auditarFirebaserc('.firebaserc', JSON.stringify({ projects: { production: 'vpw-prod-dd6ff', default: 'vpw-dev' } }))).toHaveLength(0);
  });

  it('un `--config` ajeno se rechaza: trae su propio mapa de alias', () => {
    expect(errores(['--only', 'firestore:rules', '--project', 'vpw-staging', '--config', '/tmp/otro.json']))
      .toMatch(/Config no reconocido/);
  });
});

describe('rutas de deploy que no son un comando de shell', () => {
  it('la acción oficial de Hosting recibe el destino por parámetro, no por comando', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - uses: FirebaseExtended/action-hosting-deploy@v0\n        with:\n          projectId: vpw-prod-dd6ff\n          channelId: live\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => h.severidad === 'CRITICO')).toBe(true);
  });

  it('una acción de firebase sin `projectId` deja el destino al default', () => {
    const yaml = 'jobs:\n  x:\n    steps:\n      - uses: FirebaseExtended/action-hosting-deploy@v0\n        with:\n          channelId: live\n';
    expect(auditarWorkflow('w.yml', yaml).some((h) => /sin destino explicito/.test(h.titulo))).toBe(true);
  });

  it('una composite action fuera de `.github/workflows/` también se audita', () => {
    const yaml = 'runs:\n  steps:\n    - run: firebase deploy --only functions --project vpw-prod-dd6ff --force\n';
    expect(auditarWorkflow('.github/actions/deploy/action.yml', yaml).some((h) => h.severidad === 'CRITICO')).toBe(true);
  });

  it('la forma de ARRAY de spawn — la que usa el propio helper — no se escapa', () => {
    expect(auditarScript('x.mjs', "spawnSync('firebase',['deploy','--project','vpw-prod-dd6ff']);").some((h) => h.severidad === 'CRITICO')).toBe(true);
    expect(auditarScript('y.mjs', "execa('firebase deploy --only functions --project vpw-prod-dd6ff');").some((h) => h.severidad === 'CRITICO')).toBe(true);
  });

  it('un archivo que se LLAMA como el helper pero vive en otro lado no hereda su exención', () => {
    const pkg = JSON.stringify({ scripts: { x: 'node tools/firebase-deploy.mjs --project vpw-staging' } });
    expect(auditarPackageJson('p.json', pkg).some((h) => /paralelo al helper/.test(h.titulo))).toBe(true);
  });

  it('un heredoc que DOCUMENTA el runbook no rompe el build', () => {
    const sh = 'cat <<EOF\nUsar: firebase deploy --only functions --project vpw-prod-dd6ff --force\nEOF\n';
    expect(auditarScript('ayuda.sh', sh)).toHaveLength(0);
  });
});

describe('selectores de Functions legítimos que firebase documenta', () => {
  it('acepta `codebase:funcion` y `grupo.subfuncion`', () => {
    expect(ok(['--only', 'functions:default:onWebhookInbox', '--project', 'vpw-staging', '--config', 'firebase.functions.json'])).toBe(true);
    expect(ok(['--only', 'functions:grupo.sub', '--project', 'vpw-staging', '--config', 'firebase.functions.json'])).toBe(true);
  });
});

describe('árbol real — el verificador corre sobre el repo y debe estar en VERDE', () => {
  const raiz = raizRepo();

  it('descubre los workflows por recorrido, no por lista fija', () => {
    const { workflows, packages } = descubrirArchivos(raiz);
    expect(workflows.some((w: string) => w === '.github/workflows/deploy.yml')).toBe(true);
    expect(packages.length).toBeGreaterThan(3);
  });

  it('ninguna ruta ejecutable de deploy del repo es insegura', () => {
    const hs = auditarArbol(raiz);
    expect(hs.map((h) => `${h.archivo}: ${h.titulo}`)).toEqual([]);
  });

  it('el workflow vigente no ofrece producción ni despliega Functions', () => {
    const yaml = readFileSync(join(raiz, '.github', 'workflows', 'deploy.yml'), 'utf8');
    const ejecutable = sinComentarios(yaml);
    expect(ejecutable).not.toMatch(/^\s*-\s*production\s*$/m);
    expect(ejecutable).not.toMatch(/--only[\s=][^\n]*functions/);
    expect(ejecutable).not.toMatch(/--force/);
    expect(ejecutable).toMatch(/--project vpw-staging/);
  });
});
