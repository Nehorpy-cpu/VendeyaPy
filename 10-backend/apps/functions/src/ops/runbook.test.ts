/**
 * runbook.test.ts — El runbook tiene que ser EJECUTABLE, no verosímil.
 * ====================================================================
 * Dos defectos reales, encontrados el mismo día, motivan este archivo:
 *
 *  1. `docs/deploy.md` prescribía `firebase hosting:rollback` como PASO 1 del rollback. Ese
 *     comando **no existe** en firebase-tools 15.23.0 — nunca existió en las versiones que usa
 *     este repo. O sea: el procedimiento de emergencia fallaba en su primer comando, y nadie lo
 *     supo porque un runbook no se ejecuta hasta que hay un incendio.
 *  2. `pnpm deploy:rules` quedó hardcodeado a `--project vpw-staging`. Un operador que lo corriera
 *     creyendo que despliega producción se llevaría **EXIT 0** y producción intacta: el peor tipo
 *     de falla, la que se parece a un éxito.
 *
 * De ahí la regla que estos tests imponen: **todo comando del runbook se verifica contra el CLI
 * realmente instalado**, y **ningún script puede elegir un entorno en silencio**.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const aqui = dirname(fileURLToPath(import.meta.url));
const backend = join(aqui, '..', '..', '..', '..'); // 10-backend
const repo = join(backend, '..');

/**
 * El CLI se RESUELVE desde el repo, no se hardcodea una ruta de máquina.
 *
 * La primera versión de este archivo apuntaba a la instalación global de Windows del autor. Tres
 * cosas mal, y las tres son la misma enfermedad que el release viene a curar: (1) en CI —que corre
 * en `ubuntu-latest`— esa ruta no existe y el test EXPLOTA; (2) el fallback «si no está, devolvé un
 * Set vacío» hacía que el assert de `hosting:rollback` pasara contra la nada, o sea un test que
 * deja de testear en silencio y sigue reportando verde; y (3) validaba un binario que el repo NO
 * ejecuta: los comandos del runbook y `firebase-deploy.mjs` usan el devDependency
 * (`firebase-tools@^13`), no el global. Verificar la herramienta equivocada es no verificar.
 */
const CLI = dirname(createRequire(join(backend, 'package.json')).resolve('firebase-tools/package.json'));

const leer = (p: string) => readFileSync(p, 'utf8');
const deployMd = () => leer(join(repo, 'docs', 'deploy.md'));

/** Comandos `firebase <algo>` que el CLI del repo registra realmente. */
function comandosDisponibles(): Set<string> {
  const dir = join(CLI, 'lib', 'commands');
  // Ausencia ⇒ ERROR, jamás un Set vacío: un verificador que se apaga solo no es un verificador.
  if (!existsSync(dir)) throw new Error(`no se pudo ubicar lib/commands de firebase-tools en ${CLI}`);
  const nombres = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'index.js') continue;
    // `hosting-clone.js` → `hosting:clone`
    nombres.add(f.replace(/\.js$/, '').replace(/-/g, ':'));
  }
  return nombres;
}

describe('el runbook solo prescribe comandos que existen', () => {
  it('el CLI que se inspecciona es el que el repo EJECUTA (devDependency, no el global)', () => {
    const pkg = JSON.parse(leer(join(CLI, 'package.json')));
    expect(pkg.name).toBe('firebase-tools');
    // Que resuelva por node_modules es la garantía de que es el mismo binario que corre
    // `pnpm exec firebase` y que `firebase-deploy.mjs` invoca vía require.resolve.
    expect(CLI).toContain('node_modules');
    expect(comandosDisponibles().size).toBeGreaterThan(20);
  });

  it('`hosting:rollback` NO existe — por eso no puede estar en el runbook', () => {
    // Este assert documenta el hecho que rompió el procedimiento. Si una versión futura del CLI
    // lo agregara, este test avisa y recién ahí tendría sentido volver a documentarlo.
    expect(comandosDisponibles().has('hosting:rollback')).toBe(false);
  });

  it('el mecanismo de rollback de Hosting que documenta el runbook SÍ existe', () => {
    expect(comandosDisponibles().has('hosting:clone')).toBe(true);
  });

  it('TODO comando `firebase x:y` citado en docs/deploy.md existe en el CLI instalado', () => {
    const md = deployMd();
    const disponibles = comandosDisponibles();
    // Solo comandos con namespace (`hosting:clone`, `functions:delete`…): `firebase deploy` y
    // `firebase use` son de un solo token y se registran distinto.
    const citados = [...md.matchAll(/firebase\s+([a-z]+:[a-z:]+)/g)].map((m) => m[1]);
    const inexistentes = [...new Set(citados)].filter((c) => !disponibles.has(c));
    expect(inexistentes, `citados en docs/deploy.md pero ausentes del CLI: ${JSON.stringify(inexistentes)}`).toEqual([]);
  });
});

describe('el rollback contempla los schedulers que el release crea', () => {
  const md = () => deployMd();

  it('documenta que un rollback de código NO frena un scheduler', () => {
    expect(md()).toMatch(/scheduler/i);
    expect(md()).toMatch(/rollback de código NO los frena|no frena.{0,40}scheduler/i);
  });

  it('documenta cómo PAUSARLO, con un mecanismo concreto', () => {
    expect(md()).toMatch(/jobs pause|:pause/);
  });

  it('documenta cómo REANUDARLO — pausar sin reanudar deja el sistema a medias', () => {
    expect(md()).toMatch(/jobs resume|:resume|reanud/i);
  });

  it('recuerda verificar el flag que gobierna su efecto antes de confiar en la pausa', () => {
    expect(md()).toMatch(/purgeEnabled/);
  });
});

describe('ningún script de deploy elige entorno en silencio', () => {
  const paquetes = [
    join(backend, 'package.json'),
    join(backend, 'packages', 'firebase-config', 'package.json'),
    join(backend, 'apps', 'functions', 'package.json'),
    join(backend, 'apps', 'web', 'package.json'),
  ].filter(existsSync);

  /** Todos los scripts npm que invocan un deploy real de firebase. */
  function scriptsDeDeploy(): Array<{ pkg: string; nombre: string; cmd: string }> {
    const out: Array<{ pkg: string; nombre: string; cmd: string }> = [];
    for (const p of paquetes) {
      const j = JSON.parse(leer(p));
      for (const [nombre, cmd] of Object.entries((j.scripts ?? {}) as Record<string, string>)) {
        if (/firebase-deploy\.mjs|firebase\s+deploy/.test(cmd)) out.push({ pkg: p, nombre, cmd });
      }
    }
    return out;
  }

  it('hay scripts de deploy que auditar (si esto da 0, el test dejó de proteger algo)', () => {
    expect(scriptsDeDeploy().length).toBeGreaterThan(0);
  });

  it('NINGUNO fija el proyecto por su cuenta: el entorno lo dice el operador', () => {
    // `pnpm deploy:rules` traía `--project vpw-staging` adentro. El operador que lo corría
    // pensando en producción se llevaba EXIT 0 y prod sin tocar. Un script de deploy puede
    // RESTRINGIR destinos, pero no puede ELEGIR uno callado.
    const conProyectoFijo = scriptsDeDeploy().filter((s) => /--project\s+\S/.test(s.cmd));
    expect(
      conProyectoFijo.map((s) => `${s.nombre}: ${s.cmd}`),
      'un script de deploy no puede traer --project hardcodeado',
    ).toEqual([]);
  });

  it('el runbook advierte explícitamente sobre el falso EXIT 0', () => {
    expect(deployMd()).toMatch(/falso positivo|EXIT 0|sale con éxito/i);
  });
});
