/**
 * deployEnv.test.ts — Aislamiento de secretos POR ENTORNO en el artefacto de deploy.
 * =================================================================================
 * Por qué existe: el deploy de adjuntos (2026-08-01) mostró que `build-deploy.mjs` copiaba al
 * artefacto CUALQUIER archivo que matcheara `/^\.env(\.|$)/` y no terminara en `.local`. En una
 * máquina que tiene `.env.vpw-staging` —o sea, cualquier máquina desde la que alguna vez se
 * desplegó a staging— eso metía los secretos de STAGING dentro del bundle de fuentes de
 * PRODUCCIÓN. No cambiaba la configuración en runtime (firebase solo carga `.env` y
 * `.env.<projectId>`), pero dejaba credenciales en texto plano en un bucket de otro entorno.
 *
 * La lección que estos tests cablean: **el empaquetado no puede ignorar a qué proyecto se
 * despliega.** Un filtro que solo mira la FORMA del nombre no puede distinguir "el env de este
 * deploy" de "el env de otro entorno" — hay que anclarlo al projectId destino, que firebase
 * expone al hook `predeploy` como `GCLOUD_PROJECT` (`lib/deploy/lifecycleHooks.js:61`, ya resuelto
 * de alias por `needProjectId`).
 *
 * Ningún test de este archivo lee, imprime ni compara VALORES de secretos: todo se decide sobre
 * NOMBRES de archivo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolverProyectoDestino, seleccionarEnvsDeploy } from '../../scripts/build-deploy.mjs';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'); // 10-backend

/** El directorio real de una máquina que despliega a los dos entornos. Es el caso que falló. */
const ARCHIVOS_REALES = [
  '.env.local',
  '.env.vpw-prod-dd6ff',
  '.env.vpw-staging',
  'package.json',
  'lib',
  'scripts',
];

const PROD = 'vpw-prod-dd6ff';
const STAGING = 'vpw-staging';

describe('resolverProyectoDestino — sin destino no se empaqueta', () => {
  it('toma el projectId que firebase expone al predeploy (GCLOUD_PROJECT)', () => {
    const r = resolverProyectoDestino({ env: { GCLOUD_PROJECT: PROD }, argv: [] });
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe(PROD);
  });

  it('un --project explícito gana, para poder inspeccionar el artefacto sin desplegar', () => {
    const r = resolverProyectoDestino({ env: { GCLOUD_PROJECT: PROD }, argv: ['--project', STAGING] });
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe(STAGING);
  });

  it('ABORTA si no hay destino: un artefacto sin proyecto es un artefacto ambiguo', () => {
    const r = resolverProyectoDestino({ env: {}, argv: [] });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('proyecto_ausente');
  });

  it('ABORTA ante un --project repetido con valores distintos (el bypass clásico)', () => {
    // firebase usa commander y se queda con la ÚLTIMA ocurrencia; un lector ingenuo toma la
    // primera y empaqueta el env equivocado. Acá la ambigüedad es un error, no una preferencia.
    const r = resolverProyectoDestino({ env: {}, argv: ['--project', STAGING, '--project', PROD] });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('proyecto_ambiguo');
  });

  it('ABORTA ante un projectId con forma inválida (no se construye un path con eso)', () => {
    for (const malo of ['../otro', 'proj/../x', '', 'a b', 'x/y']) {
      const r = resolverProyectoDestino({ env: { GCLOUD_PROJECT: malo }, argv: [] });
      expect(r.ok, `projectId=${JSON.stringify(malo)}`).toBe(false);
    }
  });
});

describe('seleccionarEnvsDeploy — un artefacto, un entorno', () => {
  it('PRODUCCIÓN: incluye solo el env del proyecto y JAMÁS el de staging', () => {
    const r = seleccionarEnvsDeploy(ARCHIVOS_REALES, PROD);
    expect(r.error).toBeNull();
    expect(r.incluir).toEqual(['.env.vpw-prod-dd6ff']);
    expect(r.incluir).not.toContain('.env.vpw-staging');
    expect(r.incluir).not.toContain('.env.local');
  });

  it('STAGING: incluye solo el env de staging y JAMÁS el productivo', () => {
    const r = seleccionarEnvsDeploy(ARCHIVOS_REALES, STAGING);
    expect(r.error).toBeNull();
    expect(r.incluir).toEqual(['.env.vpw-staging']);
    expect(r.incluir).not.toContain('.env.vpw-prod-dd6ff');
  });

  it('los archivos de otro entorno se reportan como EXCLUIDOS, no se ignoran en silencio', () => {
    // Que el operador vea qué se dejó afuera es la mitad del arreglo: un filtro silencioso es
    // exactamente lo que permitió que esto pasara sin que nadie lo notara durante meses.
    const r = seleccionarEnvsDeploy(ARCHIVOS_REALES, PROD);
    expect(r.excluir).toContain('.env.vpw-staging');
    expect(r.excluir).toContain('.env.local');
  });

  it('NINGÚN `.local` entra jamás, sea del proyecto que sea', () => {
    const archivos = ['.env.local', '.env.production.local', `.env.${PROD}.local`, `.env.${PROD}`];
    const r = seleccionarEnvsDeploy(archivos, PROD);
    expect(r.incluir).toEqual([`.env.${PROD}`]);
    expect(r.incluir.some((f) => f.endsWith('.local'))).toBe(false);
  });

  it('el `.env` base SÍ entra: firebase lo carga para todos los proyectos', () => {
    // No es una fuga: es configuración compartida por diseño, la misma semántica que usa
    // firebase-tools al resolver variables. Lo que no puede entrar es el env de OTRO proyecto.
    const r = seleccionarEnvsDeploy(['.env', `.env.${PROD}`, '.env.vpw-staging'], PROD);
    expect(r.incluir.sort()).toEqual(['.env', `.env.${PROD}`].sort());
  });

  it('ABORTA si falta el env del proyecto destino (desplegar sin config no es un accidente aceptable)', () => {
    const r = seleccionarEnvsDeploy(['.env.vpw-staging', '.env.local'], PROD);
    expect(r.error).toBe('env_del_proyecto_faltante');
    expect(r.incluir).toEqual([]);
  });

  it('no se deja engañar por nombres parecidos', () => {
    const trampas = [
      `.env.${PROD}.bak`,
      `.env.${PROD}-old`,
      `.env.${PROD}2`,
      `.envnot`,
      `.env.${STAGING}`,
      `x.env.${PROD}`,
    ];
    const r = seleccionarEnvsDeploy([...trampas, `.env.${PROD}`], PROD);
    expect(r.incluir).toEqual([`.env.${PROD}`]);
  });

  // firebase-tools lee `.env.<projectId>` Y `.env.<alias>` (`lib/functions/env.js:149-153`). Si la
  // allowlist ignorara los alias, un `.env.production` legítimo se caería del artefacto EN SILENCIO
  // y la función quedaría desplegada con otra configuración. Excluirlo sería tan malo como incluir
  // el de otro entorno: las dos formas de equivocarse son invisibles.
  const ALIASES = { dev: 'vpw-dev', staging: STAGING, production: PROD };

  it('el `.env.<alias>` del MISMO proyecto entra (firebase también lo carga)', () => {
    const r = seleccionarEnvsDeploy([`.env.${PROD}`, '.env.production', '.env.staging'], PROD, ALIASES);
    expect(r.incluir.sort()).toEqual(['.env.production', `.env.${PROD}`].sort());
  });

  it('el `.env.<alias>` de OTRO proyecto NO entra, aunque sea un alias válido', () => {
    const r = seleccionarEnvsDeploy([`.env.${PROD}`, '.env.staging', '.env.dev'], PROD, ALIASES);
    expect(r.incluir).toEqual([`.env.${PROD}`]);
    expect(r.excluir).toContain('.env.staging');
    expect(r.excluir).toContain('.env.dev');
  });

  it('sin alias declarados se comporta igual que antes (el mapa es opcional)', () => {
    const r = seleccionarEnvsDeploy(ARCHIVOS_REALES, PROD);
    expect(r.incluir).toEqual([`.env.${PROD}`]);
  });

  it('la selección es determinística y no depende del orden del directorio', () => {
    const a = seleccionarEnvsDeploy(ARCHIVOS_REALES, PROD);
    const b = seleccionarEnvsDeploy([...ARCHIVOS_REALES].reverse(), PROD);
    expect(a.incluir).toEqual(b.incluir);
  });

  /**
   * SEGUNDA LÍNEA, INDEPENDIENTE DE LA PRIMERA. La allowlist decide qué env entra al ARTEFACTO;
   * esto decide qué archivos suben al BUCKET. Son cosas distintas y hacían falta las dos:
   *
   *  · `firebase.json` apunta a `apps/functions` DIRECTO, sin pasar por el artefacto. Sin excluir
   *    `.env*` subía `.env.vpw-staging` Y `.env.vpw-prod-dd6ff` juntos — filtraba MÁS que el bug
   *    original. Y la subida ocurre ANTES de que Cloud Build falle por `workspace:*`, así que hasta
   *    un deploy fallido dejaba los secretos en el bucket.
   *  · `firebase.functions.json` subía el env productivo en texto plano en cada deploy, a un bucket
   *    con superficie de lectura mucho más ancha que Secret Manager.
   *
   * Excluirlos NO cambia una sola variable desplegada: firebase lee los `.env` del DISCO LOCAL en
   * `prepare` (`functions/env.js` → `loadUserEnvs`, que usa `configDir/functionsSource`), y el
   * `ignore` solo gobierna el zip. Verificado contra el walker real del CLI del repo.
   */
  const CONFIGS = ['firebase.json', 'firebase.functions.json'];

  it.each(CONFIGS)('%s excluye TODO `.env*` de la subida', (cfg) => {
    const ignore: string[] = JSON.parse(readFileSync(join(backend, cfg), 'utf8')).functions[0].ignore;
    // `.env` (el base) y `.env.*` (todos los de proyecto/alias y los `.local`).
    expect(ignore, `${cfg} debe excluir el .env base`).toContain('.env');
    expect(ignore, `${cfg} debe excluir los .env.<algo>`).toContain('.env.*');
  });

  it.each(CONFIGS)('%s conserva las exclusiones que ya tenía (no se pisó nada)', (cfg) => {
    const ignore: string[] = JSON.parse(readFileSync(join(backend, cfg), 'utf8')).functions[0].ignore;
    for (const previo of ['node_modules', '.git', '*.local']) expect(ignore).toContain(previo);
  });

  it('EL CASO QUE FALLÓ: el filtro viejo aprobaba staging en un deploy productivo', () => {
    // Regresión explícita del defecto original (`/^\.env(\.|$)/.test(f) && !f.endsWith('.local')`).
    const filtroViejo = (f: string) => /^\.env(\.|$)/.test(f) && !f.endsWith('.local');
    const loQueCopiabaAntes = ARCHIVOS_REALES.filter(filtroViejo);
    expect(loQueCopiabaAntes).toContain('.env.vpw-staging'); // así era: staging viajaba a prod

    const ahora = seleccionarEnvsDeploy(ARCHIVOS_REALES, PROD);
    expect(ahora.incluir).not.toContain('.env.vpw-staging');
  });
});
