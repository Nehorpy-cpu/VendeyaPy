/**
 * backupSafety.test.ts — Las guardas de las herramientas de backup, y por qué cada una existe.
 * ============================================================================================
 * Cada caso rojo de este archivo está calcado de un defecto REAL de `export-tenant.mjs`, tal como
 * lo dejó la auditoría:
 *
 *   · `const tenantId = process.argv[2] || 'perfumeria'`  → un tenant HARDCODEADO como default,
 *     que además viola la regla del proyecto de no cablear un tenant en el backend.
 *   · caída al emulador en silencio si no había ni `FIRESTORE_EMULATOR_HOST` ni credenciales
 *     → un operador podía creer que exportó producción y llevarse un archivo del emulador local.
 *   · `const outPath = process.argv[3] || \`${tenantId}-export.json\`` → datos privados escritos en
 *     el cwd, o sea típicamente ADENTRO del repo, sin regla de `.gitignore` que los cubriera.
 *   · `process.exit(0)` incondicional → un export vacío salía con éxito.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolverDestino, validarSalida, leerFlag, esAplicar, RAIZ_REPO, RAIZ_BACKEND, ADVERTENCIAS, manifiestoBase } from '../../scripts/backup-lib.mjs';
import { validarArgsExport } from '../../scripts/export-tenant.mjs';
import { referenciasDeSecreto, resumirPorColeccion } from '../../scripts/backup-firestore.mjs';
import { perteneceAlTenant, proyectarUsuario, resumirRoles } from '../../scripts/backup-auth.mjs';
import { familiaDeRuta, elegirMuestra, resumirObjetos, prefijoTenant } from '../../scripts/backup-storage.mjs';

const FUERA = process.platform === 'win32' ? 'D:\\backups\\vpw' : '/var/backups/vpw';

describe('resolverDestino — el proyecto se declara, nunca se adivina', () => {
  it('ABORTA sin `--project`: no hay destino por defecto ni caída al emulador', () => {
    const r = resolverDestino({ env: {}, argv: ['--tenant', 't1'] });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('proyecto_ausente');
  });

  it('ABORTA aunque el entorno traiga GCLOUD_PROJECT: el env no puede elegir el destino solo', () => {
    // Es exactamente el patrón `process.env.GCLOUD_PROJECT ??= 'demo-aiafg'` del exportador.
    const r = resolverDestino({ env: { GCLOUD_PROJECT: 'demo-aiafg' }, argv: [] });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('proyecto_ausente');
  });

  it('ABORTA ante `--project` repetido (firebase se queda con el último: mirar el primero es un bypass)', () => {
    const r = resolverDestino({ env: {}, argv: ['--project', 'demo-aiafg', '--project', 'vpw-prod-dd6ff'] });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('proyecto_ambiguo');
  });

  it('ABORTA si GCLOUD_PROJECT contradice a `--project`', () => {
    const r = resolverDestino({ env: { GCLOUD_PROJECT: 'vpw-prod-dd6ff' }, argv: ['--project', 'demo-aiafg'] });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('proyecto_ambiguo');
  });

  it('acepta un destino explícito y REPORTA si es emulador (el restore lo va a exigir)', () => {
    const r = resolverDestino({ env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, argv: ['--project', 'demo-aiafg'] });
    expect(r.ok).toBe(true);
    expect(r.projectId).toBe('demo-aiafg');
    expect(r.esEmulador).toBe(true);
  });

  it('rechaza un projectId con forma inválida (con ese valor se arman rutas)', () => {
    expect(resolverDestino({ env: {}, argv: ['--project', '../escape'] }).motivo).toBe('proyecto_invalido');
  });
});

describe('validarSalida — los datos privados no viven adentro del repo', () => {
  it('RECHAZA una ruta relativa: depende del cwd, y así fue como terminaron en el repo', () => {
    expect(validarSalida('./backup').motivo).toBe('salida_relativa');
    expect(validarSalida('perfumeria-export.json').motivo).toBe('salida_relativa');
  });

  it('RECHAZA cualquier ruta adentro del repo git, no solo adentro de 10-backend', () => {
    expect(validarSalida(join(RAIZ_BACKEND, 'tmp-backup')).motivo).toBe('salida_en_repo');
    expect(validarSalida(join(RAIZ_REPO, 'docs', 'backup')).motivo).toBe('salida_en_repo');
    expect(validarSalida(RAIZ_REPO).motivo).toBe('salida_en_repo');
  });

  it('ACEPTA un destino absoluto fuera del repo', () => {
    const r = validarSalida(FUERA);
    expect(r.ok).toBe(true);
  });

  it('exige la ruta: sin `--out` no hay backup', () => {
    expect(validarSalida(null).motivo).toBe('salida_ausente');
    expect(validarSalida('').motivo).toBe('salida_ausente');
  });
});

describe('flags — un flag repetido es un error, no "gana el último"', () => {
  it('detecta la repetición en vez de elegir en silencio', () => {
    expect(leerFlag(['--tenant', 'a', '--tenant', 'b'], 'tenant').ambiguo).toBe(true);
    expect(leerFlag(['--tenant=a', '--tenant', 'b'], 'tenant').ambiguo).toBe(true);
  });

  it('lee las dos formas (`--f v` y `--f=v`)', () => {
    expect(leerFlag(['--tenant', 'a'], 'tenant').valor).toBe('a');
    expect(leerFlag(['--tenant=a'], 'tenant').valor).toBe('a');
  });

  it('DRY-RUN es el default: los efectos exigen `--apply`', () => {
    expect(esAplicar([])).toBe(false);
    expect(esAplicar(['--tenant', 'a'])).toBe(false);
    expect(esAplicar(['--apply'])).toBe(true);
  });
});

describe('export-tenant — las tres guardas que le faltaban', () => {
  const ENV_EMU = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
  const base = ['--project', 'demo-aiafg', '--out', join(FUERA, 'x.json')];

  it('ABORTA sin `--tenant`: se acabó el default `perfumeria` hardcodeado', () => {
    const r = validarArgsExport(base, ENV_EMU);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('tenant_ausente');
  });

  it('el default hardcodeado ya no existe en el código', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(join(RAIZ_BACKEND, 'apps', 'functions', 'scripts', 'export-tenant.mjs'), 'utf8');
    // Sin comillas alrededor no alcanza: lo que importa es que no haya un tenant literal usable.
    expect(fuente).not.toMatch(/argv\[2\]\s*\|\|\s*'[a-z]+'/);
    expect(fuente).not.toMatch(/=\s*'perfumeria'/);
  });

  it('rechaza la forma POSICIONAL heredada con el comando de reemplazo, no con un error críptico', () => {
    const r = validarArgsExport(['perfumeria', './out.json'], ENV_EMU);
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('forma_posicional_obsoleta');
    expect(r.ayuda).toMatch(/--tenant/);
  });

  it('NO confunde el VALOR de un flag con un posicional heredado', () => {
    // Regresión real: la primera versión filtraba "lo que no empieza con --", así que `demo-aiafg`
    // (el valor de `--project`) contaba como posicional y una invocación correcta se rechazaba con
    // el mensaje equivocado.
    const r = validarArgsExport(['--tenant', 't1', ...base], ENV_EMU);
    expect(r.ok).toBe(true);
    expect(r.motivo).toBeUndefined();
  });

  it('ABORTA si nadie declaró el entorno: nunca más una caída al emulador en silencio', () => {
    const r = validarArgsExport(['--tenant', 't1', ...base], {});
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('entorno_no_declarado');
  });

  it('ABORTA si el entorno declara emulador Y credenciales a la vez', () => {
    const r = validarArgsExport(['--tenant', 't1', ...base], { ...ENV_EMU, GOOGLE_APPLICATION_CREDENTIALS: './sa.json' });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('entorno_ambiguo');
  });

  it('ABORTA si `--out` es relativo o cae adentro del repo', () => {
    expect(validarArgsExport(['--tenant', 't1', '--project', 'demo-aiafg', '--out', './x.json'], ENV_EMU).motivo).toBe('salida_relativa');
    expect(validarArgsExport(['--tenant', 't1', '--project', 'demo-aiafg', '--out', join(RAIZ_BACKEND, 'x.json')], ENV_EMU).motivo).toBe('salida_en_repo');
  });

  it('ACEPTA la invocación completa y correcta', () => {
    const r = validarArgsExport(['--tenant', 't1', ...base], ENV_EMU);
    expect(r.ok).toBe(true);
    expect(r.tenantId).toBe('t1');
    expect(r.esEmulador).toBe(true);
    expect(r.includePrivate).toBe(false);
  });

  it('sigue soportando `--include-private` (la privacidad por defecto no cambió)', () => {
    expect(validarArgsExport(['--tenant', 't1', ...base, '--include-private'], ENV_EMU).includePrivate).toBe(true);
  });
});

describe('secretos — se respaldan por REFERENCIA, y por forma del valor', () => {
  it('encuentra la referencia esté en el campo que esté, incluso anidada', () => {
    const refs = referenciasDeSecreto({
      tokenSecretRef: 'secret://firestore/meta-token-t1',
      anidado: { lista: [{ otroCampoFuturo: 'secret://firestore/bancard-t1' }] },
      ruido: 'https://ejemplo/no-es-un-secreto',
    });
    expect([...refs].sort()).toEqual(['bancard-t1', 'meta-token-t1']);
  });

  it('NO se apoya en un nombre de campo: un campo nuevo queda cubierto sin tocar el código', () => {
    // Es la misma enfermedad que la lista de colecciones hardcodeada, en versión chica.
    expect([...referenciasDeSecreto({ campoQueNadiePrevio: 'secret://firestore/x' })]).toEqual(['x']);
  });

  it('no confunde un texto cualquiera con una referencia', () => {
    expect([...referenciasDeSecreto({ nota: 'el secreto está en secret:// nada' })]).toEqual([]);
  });
});

describe('conteos por colección — es lo que se compara después de un restore', () => {
  it('agrupa por ruta de colección, incluidas las subcolecciones profundas', () => {
    const r = resumirPorColeccion([
      'tenants/t1',
      'tenants/t1/customers/c1',
      'tenants/t1/customers/c1/messages/m1',
      'tenants/t1/customers/c1/messages/m2',
      'tenants/t1/customers/c1/sessions/wa_123',
    ]);
    expect(r['tenants/t1/customers/c1/messages']).toBe(2);
    expect(r['tenants/t1/customers/c1/sessions']).toBe(1);
    expect(r['tenants/t1/customers']).toBe(1);
    expect(r.tenants).toBe(1);
  });
});

describe('auth — la pertenencia se decide por el CLAIM, que es lo que leen las Rules', () => {
  it('pertenece quien tiene el claim, no quien tiene el documento', () => {
    expect(perteneceAlTenant({ customClaims: { tenantId: 't1', role: 'TENANT_OWNER' } }, 't1')).toBe(true);
    expect(perteneceAlTenant({ customClaims: { tenantId: 'otro' } }, 't1')).toBe(false);
    expect(perteneceAlTenant({ customClaims: null }, 't1')).toBe(false);
    expect(perteneceAlTenant({}, 't1')).toBe(false);
  });

  it('la proyección NO incluye hashes de contraseña, aunque el SDK los devuelva', () => {
    const p = proyectarUsuario({
      uid: 'u1', email: 'a@b.c', customClaims: { tenantId: 't1', role: 'SELLER' },
      passwordHash: 'NO-DEBE-VIAJAR', passwordSalt: 'NO-DEBE-VIAJAR', providerData: [], metadata: {},
    });
    expect(JSON.stringify(p)).not.toContain('NO-DEBE-VIAJAR');
    expect('passwordHash' in p).toBe(false);
    expect(p.role).toBe('SELLER');
    expect(p.tenantId).toBe('t1');
  });

  it('resume por rol: sin ese conteo no se puede comprobar que la autorización quedó igual', () => {
    expect(resumirRoles([{ role: 'TENANT_OWNER' }, { role: 'SELLER' }, { role: 'SELLER' }, {}])).toEqual({
      '(sin role)': 1, SELLER: 2, TENANT_OWNER: 1,
    });
  });
});

describe('storage — inventario y muestreo', () => {
  it('deriva la familia del objeto de la ruta (permite contar sin exponer nombres)', () => {
    expect(familiaDeRuta('tenants/t1/attachments/2026-08/abc')).toBe('attachments');
    expect(familiaDeRuta('tenants/t1/orders/o1/comprobantes/x.jpg')).toBe('orders');
    expect(prefijoTenant('t1')).toBe('tenants/t1/');
  });

  it('el muestreo es DETERMINÍSTICO: un hallazgo se puede reproducir', () => {
    const objs = ['a', 'b', 'c'].map((n) => ({ nombre: `tenants/t1/products/${n}`, familia: 'products', tamano: 1, eliminadoEn: null }));
    expect(elegirMuestra(objs, 2)).toEqual(elegirMuestra(objs, 2));
  });

  it('la muestra se REPARTE entre familias: 5 objetos todos de `products` no dicen nada de `attachments`', () => {
    const objs = [
      ...Array.from({ length: 10 }, (_, i) => ({ nombre: `tenants/t1/products/p${i}`, familia: 'products', tamano: 1, eliminadoEn: null })),
      { nombre: 'tenants/t1/attachments/a0', familia: 'attachments', tamano: 1, eliminadoEn: null },
    ];
    expect(elegirMuestra(objs, 2).map((o) => o.familia).sort()).toEqual(['attachments', 'products']);
  });

  it('no muestrea versiones NO vigentes (no se pueden comparar contra el estado actual)', () => {
    const objs = [{ nombre: 'tenants/t1/products/p', familia: 'products', tamano: 1, eliminadoEn: '2026-01-01T00:00:00Z' }];
    expect(elegirMuestra(objs, 3)).toEqual([]);
  });

  it('el resumen separa vigentes de versiones antiguas', () => {
    const r = resumirObjetos([
      { nombre: 'x', familia: 'products', tamano: 10, eliminadoEn: null },
      { nombre: 'x', familia: 'products', tamano: 8, eliminadoEn: '2026-01-01T00:00:00Z' },
    ]);
    expect(r).toMatchObject({ total: 2, vigentes: 1, versionesNoVigentes: 1, bytes: 18 });
  });
});

describe('el manifiesto lleva escrito lo que un restore NO puede deshacer', () => {
  const texto = ADVERTENCIAS.join(' | ');

  it('dice que restaurar Firebase no deshace lo que hizo Meta ni la app del vendedor', () => {
    expect(texto).toMatch(/no deshace/i);
    expect(texto).toMatch(/Meta/);
    expect(texto).toMatch(/WhatsApp Business/i);
  });

  it('dice explícitamente que un restore NO des-onboardea un número', () => {
    expect(texto).toMatch(/des-onboardea|desonboardea/i);
  });

  it('registra las 14 semanas del backup gestionado contra el TTL de 48 h de Coexistence', () => {
    expect(texto).toMatch(/14 semanas/i);
    expect(texto).toMatch(/48 h/);
  });

  it('registra que un restore NO repone las políticas TTL', () => {
    expect(texto).toMatch(/NO REPONE LAS POLÍTICAS TTL/);
  });

  it('cada manifiesto las incluye, no solo el runbook (el runbook se lee ANTES del incidente)', () => {
    const m = manifiestoBase({ herramienta: 'x', projectId: 'demo-aiafg', esEmulador: true, tenantId: 't1', aplicado: false });
    expect(m.advertencias).toEqual(ADVERTENCIAS);
    expect(m.destino.huella).toMatch(/^[0-9a-f]{12}$/);
  });
});
