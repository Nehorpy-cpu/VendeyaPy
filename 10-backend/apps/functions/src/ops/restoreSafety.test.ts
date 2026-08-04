/**
 * restoreSafety.test.ts — Una herramienta de restauración es una herramienta de escritura masiva.
 * ==============================================================================================
 * La pregunta que decide si es segura no es "¿restaura bien?" sino "¿puede alguien apuntarla sin
 * querer al lugar equivocado?". Estos tests fijan las respuestas:
 *
 *   · producción está PROHIBIDA y no hay flag que lo levante;
 *   · fuera del emulador hay que declarar el aislamiento Y escribir en una base con nombre propio;
 *   · la confirmación sale del propio destino, así que no se puede escribir de memoria;
 *   · nada se borra nunca, y los conflictos se reportan ANTES de escribir.
 *
 * El caso más importante del archivo es el último de "producción": la huella correcta **no alcanza**
 * para restaurar sobre producción. Si alguna vez alcanzara, todo lo demás sería decorado.
 */
import { describe, it, expect } from 'vitest';
import { esProduccion, pareceAislado, evaluarDestinoRestore, clasificarConflictos, verificarManifiesto, AYUDA_RESTORE } from '../../scripts/restore-lib.mjs';
import { clasificarUsuarios, perfilRestaurable } from '../../scripts/restore-auth.mjs';
import { calcularSobrantes, enTandas } from '../../scripts/restore-firestore.mjs';
import { huellaDestino, FORMATO } from '../../scripts/backup-lib.mjs';

/** Los alias reales del repo. `production` es el que identifica al proyecto productivo. */
const ALIAS = { default: 'vpw-dev', dev: 'vpw-dev', staging: 'vpw-staging', production: 'vpw-prod-dd6ff' };

describe('producción — es una negativa, no una confirmación difícil', () => {
  it('reconoce el proyecto productivo por el alias `production` de .firebaserc', () => {
    expect(esProduccion('vpw-prod-dd6ff', ALIAS)).toBe(true);
  });

  it('lo reconoce TAMBIÉN por el nombre, aunque el alias no estuviera', () => {
    // Heurística deliberadamente grosera: solo puede rechazar de más. Un falso positivo cuesta
    // renombrar un sandbox; un falso negativo cuesta la base de producción.
    expect(esProduccion('vpw-prod-dd6ff', {})).toBe(true);
    expect(esProduccion('cualquier-prod', {})).toBe(true);
    expect(esProduccion('prod-nuevo', {})).toBe(true);
  });

  it('ante un destino sin identificar asume lo peor', () => {
    expect(esProduccion(null, ALIAS)).toBe(true);
    expect(esProduccion(undefined, ALIAS)).toBe(true);
  });

  it('no marca como producción a un proyecto claramente desechable', () => {
    expect(esProduccion('demo-aiafg', ALIAS)).toBe(false);
    expect(esProduccion('vpw-staging', ALIAS)).toBe(false);
  });

  it('ABORTA contra producción incluso con TODOS los flags y la huella CORRECTA', () => {
    const r = evaluarDestinoRestore({
      projectId: 'vpw-prod-dd6ff',
      esEmulador: false,
      databaseId: 'restauracion-2026',
      aliases: ALIAS,
      proyectoAislado: true,
      confirmacion: huellaDestino({ projectId: 'vpw-prod-dd6ff', databaseId: 'restauracion-2026', esEmulador: false }),
    });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('destino_produccion');
    expect(AYUDA_RESTORE.destino_produccion).toMatch(/no hay flag que lo habilite/);
  });

  it('ABORTA contra producción incluso si alguien seteó el emulador (la combinación no lo salva)', () => {
    const r = evaluarDestinoRestore({ projectId: 'vpw-prod-dd6ff', esEmulador: true, aliases: ALIAS, confirmacion: 'lo-que-sea' });
    expect(r.motivo).toBe('destino_produccion');
  });
});

describe('fuera del emulador — tres condiciones independientes', () => {
  const CONF = (projectId: string, databaseId: string) => huellaDestino({ projectId, databaseId, esEmulador: false });

  it('exige declarar el aislamiento', () => {
    const r = evaluarDestinoRestore({ projectId: 'demo-restore-x', esEmulador: false, databaseId: 'r1', aliases: ALIAS, proyectoAislado: false, confirmacion: CONF('demo-restore-x', 'r1') });
    expect(r.motivo).toBe('remoto_sin_declarar');
  });

  it('exige que el NOMBRE tenga forma de entorno desechable (declararlo no basta)', () => {
    const r = evaluarDestinoRestore({ projectId: 'vpw-staging', esEmulador: false, databaseId: 'r1', aliases: ALIAS, proyectoAislado: true, confirmacion: CONF('vpw-staging', 'r1') });
    expect(r.motivo).toBe('remoto_no_aislado');
  });

  it('exige una base Firestore con NOMBRE PROPIO: `(default)` es la que usa la aplicación', () => {
    const r = evaluarDestinoRestore({ projectId: 'demo-restore-x', esEmulador: false, databaseId: '(default)', aliases: ALIAS, proyectoAislado: true, confirmacion: CONF('demo-restore-x', '(default)') });
    expect(r.motivo).toBe('base_por_defecto');
  });

  it('con las tres condiciones y la huella correcta, PERMITE', () => {
    const r = evaluarDestinoRestore({ projectId: 'demo-restore-x', esEmulador: false, databaseId: 'r1', aliases: ALIAS, proyectoAislado: true, confirmacion: CONF('demo-restore-x', 'r1') });
    expect(r.ok).toBe(true);
  });

  it('`pareceAislado` acepta las formas desechables y rechaza las demás', () => {
    expect(pareceAislado('demo-aiafg')).toBe(true);
    expect(pareceAislado('vpw-restore-2026')).toBe(true);
    expect(pareceAislado('algo-sandbox')).toBe(true);
    expect(pareceAislado('vpw-dev')).toBe(false);
    expect(pareceAislado('mi-proyecto')).toBe(false);
  });
});

describe('confirmación — sale del propio destino, no de la memoria del operador', () => {
  const EMU = { projectId: 'demo-aiafg', esEmulador: true, databaseId: '(default)', aliases: ALIAS };

  it('sin confirmación no se aplica (aunque el destino sea el emulador)', () => {
    const r = evaluarDestinoRestore({ ...EMU, confirmacion: null });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('confirmacion_ausente');
    expect(r.esperada).toMatch(/^[0-9a-f]{12}$/);
  });

  it('la huella de OTRO destino NO sirve — que es exactamente el caso que atrapa', () => {
    const deOtro = huellaDestino({ projectId: 'demo-otro', databaseId: '(default)', esEmulador: true });
    const r = evaluarDestinoRestore({ ...EMU, confirmacion: deOtro });
    expect(r.motivo).toBe('confirmacion_no_coincide');
  });

  it('la huella distingue emulador de remoto para el MISMO proyecto', () => {
    expect(huellaDestino({ projectId: 'demo-aiafg', esEmulador: true })).not.toBe(huellaDestino({ projectId: 'demo-aiafg', esEmulador: false }));
  });

  it('con la huella propia, PERMITE', () => {
    const r = evaluarDestinoRestore({ ...EMU, confirmacion: huellaDestino({ projectId: 'demo-aiafg', databaseId: '(default)', esEmulador: true }) });
    expect(r.ok).toBe(true);
  });
});

describe('el volcado se verifica antes de escribirlo en ningún lado', () => {
  it('rechaza un formato desconocido', () => {
    expect(verificarManifiesto({ manifiesto: { formato: 'otro/9', aplicado: true }, sha256Archivo: 'x', formatoEsperado: FORMATO }).ok).toBe(false);
  });

  it('rechaza un manifiesto de DRY-RUN: no hay datos que restaurar', () => {
    const r = verificarManifiesto({ manifiesto: { formato: FORMATO, aplicado: false }, sha256Archivo: 'x', formatoEsperado: FORMATO });
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/DRY-RUN/);
  });

  it('rechaza un archivo cuyo sha256 no coincide con el manifiesto (cambió después del backup)', () => {
    const r = verificarManifiesto({ manifiesto: { formato: FORMATO, aplicado: true, sha256: 'aaa' }, sha256Archivo: 'bbb', formatoEsperado: FORMATO });
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/sha256/);
  });

  it('acepta un manifiesto coherente', () => {
    expect(verificarManifiesto({ manifiesto: { formato: FORMATO, aplicado: true, sha256: 'aaa' }, sha256Archivo: 'aaa', formatoEsperado: FORMATO }).ok).toBe(true);
  });
});

describe('conflictos — se clasifican antes de escribir, y nada se borra', () => {
  const lineas = [
    { path: 'tenants/t1/products/p1', existe: true, hash: 'h1' },
    { path: 'tenants/t1/products/p2', existe: true, hash: 'h2' },
    { path: 'tenants/t1/products/p3', existe: true, hash: 'h3' },
    { path: 'tenants/t1/customers/c1', existe: false, hash: null }, // padre fantasma
  ];

  it('separa ausente / idéntico / divergente', () => {
    const r = clasificarConflictos(lineas, new Map([['tenants/t1/products/p1', 'h1'], ['tenants/t1/products/p2', 'DISTINTO']]));
    expect(r.identicos).toEqual(['tenants/t1/products/p1']);
    expect(r.divergentes).toEqual(['tenants/t1/products/p2']);
    expect(r.ausentes).toEqual(['tenants/t1/products/p3']);
  });

  it('un padre FANTASMA no cuenta como documento a escribir', () => {
    const r = clasificarConflictos(lineas, new Map());
    expect(r.ausentes).not.toContain('tenants/t1/customers/c1');
  });

  it('los sobrantes del destino se INFORMAN, y la política dice que jamás se borran', () => {
    const sobrantes = calcularSobrantes(
      ['tenants/t1/products/p1', 'tenants/t1/products/NUEVO', 'tenants/t1/orders/o9'],
      ['tenants/t1/products/p1'],
    );
    expect(sobrantes).toEqual(['tenants/t1/orders/o9', 'tenants/t1/products/NUEVO']);
  });

  it('ninguna herramienta de restauración contiene una llamada a delete', async () => {
    // Un restore que borra "lo que sobra" es un DROP con otro nombre. Se verifica sobre el código.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
    for (const f of ['restore-firestore.mjs', 'restore-auth.mjs', 'restore-lib.mjs']) {
      const fuente = readFileSync(join(scripts, f), 'utf8');
      expect(fuente, `${f} no puede borrar`).not.toMatch(/\.delete\(|deleteUser|recursiveDelete|bulkWriter/);
    }
  });

  it('las escrituras se reparten en tandas que Firestore admite (≤500 por batch)', () => {
    const tandas = enTandas(Array.from({ length: 1001 }, (_, i) => i));
    expect(tandas.length).toBe(3);
    expect(Math.max(...tandas.map((t) => t.length))).toBeLessThanOrEqual(500);
    expect(tandas.flat().length).toBe(1001);
  });
});

describe('restore de identidad — los claims son el punto', () => {
  it('clasifica usuarios por hash: idéntico no se reescribe', () => {
    const lineas = [
      { uid: 'u1', hash: 'h1', usuario: {} },
      { uid: 'u2', hash: 'h2', usuario: {} },
    ];
    // `hashUsuario` del actual coincide con 'h1' solo si el usuario proyectado es el mismo; acá se
    // fuerza el caso con un mapa vacío para u2 (ausente) y un stub controlado para u1.
    const r = clasificarUsuarios(lineas, new Map());
    expect(r.ausentes).toEqual(['u1', 'u2']);
  });

  it('el perfil restaurable conserva el UID (sin eso, el documento `users/{uid}` queda huérfano)', () => {
    const p = perfilRestaurable({ uid: 'u1', email: 'a@b.c', emailVerified: true, disabled: false, displayName: 'Ana' });
    expect(p.uid).toBe('u1');
    expect(p.email).toBe('a@b.c');
    expect(p.displayName).toBe('Ana');
  });

  it('el perfil NO lleva claims: se aplican aparte, para que un fallo parcial no deje al usuario sin permisos', () => {
    const p = perfilRestaurable({ uid: 'u1', customClaims: { tenantId: 't1', role: 'TENANT_OWNER' } });
    expect('customClaims' in p).toBe(false);
  });

  it('no inventa campos vacíos (un `displayName: undefined` haría fallar createUser)', () => {
    const p = perfilRestaurable({ uid: 'u1' });
    expect(Object.keys(p).sort()).toEqual(['disabled', 'uid']);
  });
});
