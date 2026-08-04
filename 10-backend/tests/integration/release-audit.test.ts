import { describe, it, expect } from 'vitest';

/**
 * ADR-0017 (consecuencias) — DESPLEGAR SIN LA MIGRACIÓN PREVIA TIENE QUE ABORTAR.
 * ==============================================================================
 * «El orden importa: la migración del PNID actual a `live` corre ANTES de desplegar el gate. Al
 * revés, el número que vende leería el campo ausente, resolvería `inactive` y se quedaría callado
 * hasta que alguien corriera la migración.»
 *
 * Esa regla no se puede verificar en vivo: la única forma de comprobar en producción que el orden
 * inverso rompe sería desplegando el gate sobre un número con clientes reales y mirar si se calla.
 * Por eso lo que se prueba acá es la decisión PURA de `release-audit.mjs`, en memoria, con el
 * estado EXACTO que hoy tiene producción —un solo número ruteado, su asset `active`/`selected`, y
 * `automationMode` AUSENTE—: con ese estado, la auditoría sale BLOQUEADA y NO emite selector de
 * deploy. Ningún test de este archivo toca la red, el emulador ni producción, y ninguno ejecuta
 * la migración.
 *
 * El resto de los casos cubre lo que hace confiable al cálculo de la superficie: el parser
 * multilínea (un regex por línea pierde exports), la normalización que distingue un cambio de
 * comportamiento de un cambio de comentarios, el recorrido por símbolo a través de un barril y la
 * exclusión de las `dev*` que deben permanecer ausentes en producción.
 */
// `release-audit.mjs` es un script de operación en `.mjs` y no publica tipos, igual que
// `migrate-whatsapp-automation-mode.mjs`. Se importa por su VALOR —que es lo que se audita— y se
// silencia solo la resolución de tipos; si algún día el script publicara tipos, TypeScript avisaría
// de que esta directiva sobra.
// @ts-expect-error -- módulo .mjs sin declaración de tipos
import { verificarPrecondicionDeMigracion, veredictoDeRelease, clasificarSuperficie, exportsReexportados, exportsPorLinea, exportsPropios, normalizarComportamiento, construirGrafo, cierreDeExport, enmascararPnid } from '../apps/functions/scripts/release-audit.mjs';

/** El estado REAL de producción al 2026-08-04, con el número enmascarado desde el fixture. */
const PNID_QUE_RUTEA = '000000000007904';
const TENANT = 'tnt_demo';

const numeroRuteado = (automationModeCrudo: unknown) => ({
  tenantId: TENANT,
  phoneNumberId: PNID_QUE_RUTEA,
  ruteaInbound: true,
  status: 'active',
  selected: true,
  automationModeCrudo,
});

/** Superficie mínima válida, para poder mirar el veredicto sin depender del grafo real. */
const superficieOk = clasificarSuperficie({
  exportados: ['metaWebhook', 'coexistenceStart', 'devRunMetaCatalogOutbox'],
  desplegados: ['metaWebhook'],
  cambiados: new Set(['/x/webhook.ts']),
  cierres: new Map([
    ['metaWebhook', new Set(['/x/webhook.ts'])],
    ['coexistenceStart', new Set(['/x/coex.ts'])],
    ['devRunMetaCatalogOutbox', new Set(['/x/dev.ts'])],
  ]),
});

describe('precondición de migración (ADR-0017: la migración corre ANTES del deploy)', () => {
  it('BLOQUEA el release cuando el número que rutea no tiene el campo: es el estado de hoy', () => {
    const pre = verificarPrecondicionDeMigracion([numeroRuteado(undefined)]);
    expect(pre.ok).toBe(false);
    expect(pre.motivo).toBe('migracion_pendiente');
    expect(pre.evaluados).toBe(1);
    expect(pre.pendientes).toHaveLength(1);
    expect(pre.pendientes[0]?.motivo).toBe('campo_ausente');

    const v = veredictoDeRelease({ precondicion: pre, superficie: superficieOk });
    expect(v.veredicto).toBe('BLOQUEADO');
    expect(v.bloqueos).toContain('migracion_pendiente');
    // Lo que de verdad importa: un informe bloqueado no ofrece nada copiable al operador.
    expect(v.selector).toBeNull();
  });

  it('deja pasar SOLO con el valor crudo exactamente `live`', () => {
    const pre = verificarPrecondicionDeMigracion([numeroRuteado('live')]);
    expect(pre.ok).toBe(true);
    expect(pre.pendientes).toHaveLength(0);
    const v = veredictoDeRelease({ precondicion: pre, superficie: superficieOk });
    expect(v.veredicto).toBe('OK');
    expect(v.selector).toBe('functions:coexistenceStart,functions:metaWebhook');
  });

  it('es fail-closed: cualquier otro valor bloquea, incluido `LIVE` con mayúsculas', () => {
    for (const crudo of ['shadow', 'inactive', 'LIVE', 'Live', ' live', '', null, 0, true]) {
      const pre = verificarPrecondicionDeMigracion([numeroRuteado(crudo)]);
      expect(pre.ok, `modo crudo ${JSON.stringify(crudo)}`).toBe(false);
      expect(veredictoDeRelease({ precondicion: pre, superficie: superficieOk }).selector).toBeNull();
    }
  });

  it('no poder ver ningún número ruteado también bloquea (no se certifica un orden que no se vio)', () => {
    const pre = verificarPrecondicionDeMigracion([]);
    expect(pre.ok).toBe(false);
    expect(pre.motivo).toBe('sin_numeros_ruteados');
    expect(veredictoDeRelease({ precondicion: pre, superficie: superficieOk }).veredicto).toBe('BLOQUEADO');
  });

  it('un asset que NO rutea inbound no bloquea el release aunque le falte el campo', () => {
    const pre = verificarPrecondicionDeMigracion([
      numeroRuteado('live'),
      { tenantId: TENANT, phoneNumberId: '999888777', ruteaInbound: false, automationModeCrudo: undefined },
    ]);
    expect(pre.ok).toBe(true);
    expect(pre.evaluados).toBe(1);
  });

  /**
   * ADR-0017 §1 — el desempate es por el MÁS RESTRICTIVO entre asset e índice, y `accountUpdate`
   * escribe `inactive` en los DOS. Una auditoría que solo mire el asset certifica como migrado un
   * número que el gate va a leer mudo: exactamente el estado que deja un `ACCOUNT_OFFBOARDED`
   * seguido de una reconexión.
   */
  it('el índice declarado `inactive` BLOQUEA aunque el asset ya diga `live`', () => {
    const pre = verificarPrecondicionDeMigracion([
      { ...numeroRuteado('live'), automationModeIndiceCrudo: 'inactive' },
    ]);
    expect(pre.ok).toBe(false);
    expect(pre.motivo).toBe('migracion_pendiente');
    expect(pre.pendientes[0]?.motivo).toBe('indice_no_live');
    expect(veredictoDeRelease({ precondicion: pre, superficie: superficieOk }).selector).toBeNull();
  });

  it('un índice que NO declara nada no bloquea: la ausencia no vota (la migración es de un doc)', () => {
    const pre = verificarPrecondicionDeMigracion([
      { ...numeroRuteado('live'), automationModeIndiceCrudo: undefined },
      { ...numeroRuteado('live'), automationModeIndiceCrudo: null },
    ]);
    expect(pre.ok).toBe(true);
    expect(pre.pendientes).toHaveLength(0);
  });

  it('un índice espejado en `live` tampoco bloquea', () => {
    const pre = verificarPrecondicionDeMigracion([{ ...numeroRuteado('live'), automationModeIndiceCrudo: 'live' }]);
    expect(pre.ok).toBe(true);
  });

  it('el motivo del ASSET tiene prioridad: primero se ve el documento que manda', () => {
    const pre = verificarPrecondicionDeMigracion([
      { ...numeroRuteado(undefined), automationModeIndiceCrudo: 'inactive' },
    ]);
    expect(pre.pendientes[0]?.motivo).toBe('campo_ausente');
  });

  it('el informe del índice tampoco lleva el teléfono entero', () => {
    const pre = verificarPrecondicionDeMigracion([
      { ...numeroRuteado('live'), automationModeIndiceCrudo: 'shadow' },
    ]);
    expect(JSON.stringify(pre)).not.toContain(PNID_QUE_RUTEA);
    expect(pre.pendientes[0]?.declaradoIndice).toBe('shadow');
  });

  it('el informe nunca lleva el teléfono entero', () => {
    const pre = verificarPrecondicionDeMigracion([numeroRuteado(undefined)]);
    const serializado = JSON.stringify(pre);
    expect(serializado).not.toContain(PNID_QUE_RUTEA);
    expect(pre.pendientes[0]?.numero).toBe(enmascararPnid(PNID_QUE_RUTEA));
    expect(pre.pendientes[0]?.numero).toBe('…7904');
  });
});

describe('exports de index.ts: el regex por línea pierde los bloques multilínea', () => {
  const fuente = `
    export { healthCheck } from './functions/healthCheck.js';
    // export { comentado } from './functions/comentado.js';
    export {
      metaCatalogReconcilePlan,
      metaCatalogConfirmMapping,
    } from './functions/meta/catalogReconcileCallables.js';
    export type { SoloTipo } from './tipos.js';
  `;

  it('el parser multilínea los captura todos y descarta comentados y `export type`', () => {
    const nombres = exportsReexportados(fuente).map((r: { nombre: string }) => r.nombre);
    expect(nombres).toEqual(['healthCheck', 'metaCatalogReconcilePlan', 'metaCatalogConfirmMapping']);
    expect(nombres).not.toContain('comentado');
    expect(nombres).not.toContain('SoloTipo');
  });

  it('el regex por línea pierde exactamente los del bloque multilínea', () => {
    const porLinea: string[] = exportsPorLinea(fuente);
    expect(porLinea).toEqual(['healthCheck']);
    const perdidos = exportsReexportados(fuente)
      .map((r: { nombre: string }) => r.nombre)
      .filter((n: string) => !porLinea.includes(n));
    expect(perdidos).toEqual(['metaCatalogReconcilePlan', 'metaCatalogConfirmMapping']);
  });

  it('conserva el nombre ORIGEN de un alias, que es por donde hay que seguir el grafo', () => {
    const r = exportsReexportados(`export { interno as publico } from './m.js';`);
    expect(r[0]?.nombre).toBe('publico');
    expect(r[0]?.origen).toBe('interno');
  });
});

describe('normalización: qué cuenta como cambio de COMPORTAMIENTO', () => {
  const antes = "import { a } from './a.js';\nexport const x = () => a(1);\n";

  it('los comentarios y los finales de línea no cuentan', () => {
    const soloComentarios = "// nota nueva\nimport { a } from './a.js';\r\nexport const x = () => a(1);\r\n/* bloque */\n";
    expect(normalizarComportamiento(soloComentarios)).toBe(normalizarComportamiento(antes));
  });

  it('agregar un re-export a un barril no cuenta (el alcance se resuelve por símbolo)', () => {
    const conReexport = antes + "export { nuevo } from './nuevo.js';\n";
    expect(normalizarComportamiento(conReexport)).toBe(normalizarComportamiento(antes));
  });

  it('cambiar una llamada SÍ cuenta', () => {
    expect(normalizarComportamiento("import { a } from './a.js';\nexport const x = () => a(1, 'k');\n")).not.toBe(
      normalizarComportamiento(antes),
    );
  });

  it('no confunde un comentario dentro de un string con un comentario', () => {
    expect(normalizarComportamiento(`export const u = 'https://x/y';`)).toBe(`export const u = 'https://x/y';`);
  });
});

describe('cierre transitivo por símbolo', () => {
  const archivos = {
    '/p/index.ts': `
      import { wire } from './arranque.js';
      wire();
      export { alfa } from './barril.js';
      export { beta } from './beta.js';
    `,
    '/p/arranque.ts': `import { util } from './util.js';\nexport const wire = () => util();`,
    '/p/util.ts': `export const util = () => 1;`,
    '/p/barril.ts': `export * from './alfa.js';\nexport * from './hermano.js';`,
    '/p/alfa.ts': `import { hondo } from './hondo.js';\nexport const alfa = () => hondo();`,
    '/p/hermano.ts': `export const hermano = () => 2;`,
    '/p/hondo.ts': `export const hondo = () => 3;`,
    '/p/beta.ts': `export const beta = () => 4;`,
  } as Record<string, string>;
  const { grafo, noResueltos } = construirGrafo({
    archivos: Object.keys(archivos),
    leer: (p: string) => archivos[p] ?? '',
    modo: 'src',
  });

  it('resuelve todos los especificadores relativos', () => {
    expect(noResueltos).toEqual([]);
  });

  it('sigue el símbolo a través del barril y NO arrastra al hermano', () => {
    const c = cierreDeExport({ grafo, entrada: '/p/index.ts', nombre: 'alfa' });
    expect(c.has('/p/alfa.ts')).toBe(true);
    expect(c.has('/p/hondo.ts')).toBe(true);
    expect(c.has('/p/hermano.ts')).toBe(false);
  });

  it('el arranque de index.ts entra en el cierre de TODAS las funciones', () => {
    for (const n of ['alfa', 'beta']) {
      const c = cierreDeExport({ grafo, entrada: '/p/index.ts', nombre: n });
      expect(c.has('/p/arranque.ts'), n).toBe(true);
      expect(c.has('/p/util.ts'), n).toBe(true);
    }
  });

  it('cada export alcanza solo su propia rama', () => {
    expect(cierreDeExport({ grafo, entrada: '/p/index.ts', nombre: 'beta' }).has('/p/alfa.ts')).toBe(false);
  });

  it('`exportsPropios` reconoce lo que un módulo define él mismo', () => {
    expect([...exportsPropios(archivos['/p/alfa.ts'] ?? '')]).toEqual(['alfa']);
  });
});

describe('superficie: las dev* que deben permanecer AUSENTES en producción', () => {
  it('quedan fuera del selector y se declaran aparte', () => {
    expect(superficieOk.ausentesEnProdPorDiseno).toEqual(['devRunMetaCatalogOutbox']);
    expect(superficieOk.selector).not.toContain('devRunMetaCatalogOutbox');
    expect(superficieOk.create).toEqual(['coexistenceStart']);
    expect(superficieOk.update).toEqual(['metaWebhook']);
    expect(superficieOk.fugados).toEqual([]);
  });

  it('la partición es completa: ningún export se pierde ni se cuenta dos veces', () => {
    expect(superficieOk.particionCompleta).toBe(true);
  });

  it('una function desplegada que ya no se exporta aparece como DELETE, no se ignora', () => {
    const s = clasificarSuperficie({
      exportados: ['a'],
      desplegados: ['a', 'viejo'],
      cambiados: new Set<string>(),
      cierres: new Map([['a', new Set(['/x/a.ts'])]]),
    });
    expect(s.delete).toEqual(['viejo']);
    expect(s.sinCambio).toEqual(['a']);
    expect(s.selector).toEqual([]);
  });

  it('un export desplegado cuyo cierre no toca nada cambiado NO entra al selector', () => {
    const s = clasificarSuperficie({
      exportados: ['a', 'b'],
      desplegados: ['a', 'b'],
      cambiados: new Set(['/x/b.ts']),
      cierres: new Map([
        ['a', new Set(['/x/a.ts'])],
        ['b', new Set(['/x/b.ts'])],
      ]),
    });
    expect(s.update).toEqual(['b']);
    expect(s.sinCambio).toEqual(['a']);
  });
});
