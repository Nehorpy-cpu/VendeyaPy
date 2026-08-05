/**
 * restoreContencion.test.ts — La contención de paths de un restore NO confía en el bundle.
 * ========================================================================================
 * Correctivo release-safety. Un bundle de backup es un archivo en disco: nada garantiza su
 * procedencia, y las herramientas de restauración lo convierten en ESCRITURAS. Antes de este
 * correctivo (2798296):
 *
 *  · `restore-storage.mjs` leía `join(dirBackup, 'objetos', l.archivoLocal)` y subía a
 *    `bucket.file(l.nombre)` con AMBOS valores salidos del NDJSON, sin ninguna validación: un
 *    `archivoLocal` con `../` leía archivos locales arbitrarios y un `nombre` fuera de
 *    `tenants/{t}/` escribía fuera del prefijo del tenant (o del bucket lógico esperado).
 *  · `restore-firestore.mjs` hacía `db.doc(l.path)` para CUALQUIER path del volcado: un bundle
 *    adulterado podía escribir `tenants/{otro}/…`, `secrets/{ajeno}` o cualquier colección global.
 *
 * Estos tests fijan las funciones PURAS de contención que ambos scripts aplican SIEMPRE, sin
 * importar de dónde vino el bundle. Contra 2798296 este archivo es ROJO: las funciones no existían.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { nombreLocalDeObjeto, validarNombreDeObjeto, validarLineaDeBundle } from '../../scripts/restore-storage.mjs';
import { caminoSano } from '../../scripts/restore-lib.mjs';
import { contenerPathsDelBundle } from '../../scripts/restore-firestore.mjs';

const T = 'tnt-restauro';

describe('caminoSano — estructura mínima de cualquier camino que venga de un bundle', () => {
  it('acepta caminos normales', () => {
    expect(caminoSano('tenants/t1/attachments/a.jpg')).toBe(true);
    expect(caminoSano('metaExternalIndex/whatsapp_123')).toBe(true);
  });

  it('rechaza traversal, absolutos, backslashes y segmentos vacíos', () => {
    expect(caminoSano('../fuera')).toBe(false);
    expect(caminoSano('tenants/t1/../t2/x')).toBe(false);
    expect(caminoSano('tenants/t1/./x')).toBe(false);
    expect(caminoSano('/tenants/t1/x')).toBe(false);
    expect(caminoSano('tenants\\t1\\x')).toBe(false);
    expect(caminoSano('tenants//t1/x')).toBe(false);
    expect(caminoSano('tenants/t1/x/')).toBe(false);
    expect(caminoSano('')).toBe(false);
    expect(caminoSano(null)).toBe(false);
    expect(caminoSano(42)).toBe(false);
  });
});

describe('restore-storage — cada nombre de objeto queda contenido en el prefijo del tenant', () => {
  it('acepta solo objetos bajo `tenants/{tenant}/` con algo después del prefijo', () => {
    expect(validarNombreDeObjeto(`tenants/${T}/attachments/foto.jpg`, T).ok).toBe(true);
    expect(validarNombreDeObjeto(`tenants/${T}/comprobantes/a/b.pdf`, T).ok).toBe(true);
  });

  it('rechaza el escape del prefijo: otro tenant, raíz, colecciones globales', () => {
    expect(validarNombreDeObjeto('tenants/otro/attachments/x.jpg', T).ok).toBe(false);
    expect(validarNombreDeObjeto(`tenants/${T}`, T).ok).toBe(false);
    expect(validarNombreDeObjeto(`tenants/${T}/`, T).ok).toBe(false);
    expect(validarNombreDeObjeto('secrets/meta-token-x', T).ok).toBe(false);
    expect(validarNombreDeObjeto(`tenantsX/${T}/f`, T).ok).toBe(false);
  });

  it('rechaza traversal, absolutos y backslashes AUNQUE empiecen con el prefijo', () => {
    expect(validarNombreDeObjeto(`tenants/${T}/../otro/x`, T).ok).toBe(false);
    expect(validarNombreDeObjeto(`/tenants/${T}/x`, T).ok).toBe(false);
    expect(validarNombreDeObjeto(`tenants/${T}/a\\b`, T).ok).toBe(false);
    expect(validarNombreDeObjeto(`tenants/${T}//x`, T).ok).toBe(false);
  });

  it('el archivo local tiene que ser EXACTAMENTE el nombre determinístico (ni `../`, ni otro hash)', () => {
    const nombre = `tenants/${T}/attachments/foto.jpg`;
    const linea = { nombre, generation: '77', archivoLocal: nombreLocalDeObjeto(nombre, '77') };
    expect(validarLineaDeBundle(linea, T).ok).toBe(true);

    // Traversal directo: leería (y subiría) un archivo local arbitrario.
    expect(validarLineaDeBundle({ ...linea, archivoLocal: '../../.env' }, T).ok).toBe(false);
    // Un hash con FORMA válida pero de OTRO objeto/generación: los bytes no corresponderían.
    const ajeno = `obj_${createHash('sha256').update('otro').digest('hex')}`;
    expect(validarLineaDeBundle({ ...linea, archivoLocal: ajeno }, T).ok).toBe(false);
    // La generación participa del nombre: cambiarla sin recalcular el hash también se rechaza.
    expect(validarLineaDeBundle({ ...linea, generation: '78' }, T).ok).toBe(false);
    // Sin archivo local no hay nada que subir: se rechaza en vez de adivinar.
    expect(validarLineaDeBundle({ nombre, generation: '77' }, T).ok).toBe(false);
    // Y el nombre del objeto se valida ANTES que el archivo local.
    expect(validarLineaDeBundle({ nombre: 'tenants/otro/x', generation: '1', archivoLocal: nombreLocalDeObjeto('tenants/otro/x', '1') }, T).ok).toBe(false);
  });
});

describe('restore-firestore — cada path del volcado se valida contra el tenant del manifest', () => {
  /** Molde de línea del NDJSON de backup-firestore: path + data codificada. */
  const linea = (path: string, data: Record<string, unknown> | null = {}) =>
    ({ path, existe: data !== null, data, hash: data ? 'h' : null });

  it('acepta el subárbol del tenant, sus secretos REFERENCIADOS y los índices globales propios', () => {
    const lineas = [
      linea(`tenants/${T}`, { name: 'Perfumería' }),
      linea(`tenants/${T}/metaConnections/main`, { tokenSecretRef: 'secret://firestore/meta-token-x' }),
      linea(`tenants/${T}/customers/c1/messages/m1`, { text: 'hola' }),
      linea(`tenants/${T}/customers/fantasma`, null), // padre fantasma: estructura, sin datos
      linea('secrets/meta-token-x', { ciphertext: '…' }),
      linea('metaExternalIndex/whatsapp_1', { tenantId: T }),
      linea('metaExternalIndex/whatsapp_1/sub/s1', { dato: 1 }), // subárbol de un global propio
    ];
    const r = contenerPathsDelBundle(lineas, T);
    expect(r.violaciones).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rechaza paths de OTRO tenant, globales ajenos y secretos no referenciados', () => {
    const lineas = [
      linea(`tenants/${T}`, {}),
      linea('tenants/otro/orders/o1', { total: 1 }),
      linea('metaExternalIndex/whatsapp_2', { tenantId: 'otro' }),
      linea('secrets/meta-token-ajeno', { ciphertext: '…' }),
      linea('config/global', { flag: true }),
    ];
    const r = contenerPathsDelBundle(lineas, T);
    expect(r.ok).toBe(false);
    const paths = r.violaciones.map((v: { path: string }) => v.path).sort();
    expect(paths).toEqual(['config/global', 'metaExternalIndex/whatsapp_2', 'secrets/meta-token-ajeno', 'tenants/otro/orders/o1']);
  });

  it('rechaza estructura rota: traversal, backslash, rutas de colección (segmentos impares)', () => {
    const lineas = [
      linea(`tenants/${T}`, {}),
      linea(`tenants/${T}/../otro/x`, {}),
      linea(`tenants\\${T}\\x`, {}),
      linea(`tenants/${T}/metaAssets`, {}), // colección, no documento
      linea('secrets/a/b', { ciphertext: '…' }), // un secreto es un doc de DOS segmentos
    ];
    const r = contenerPathsDelBundle(lineas, T);
    expect(r.violaciones.length).toBe(4);
  });

  it('un subárbol global solo entra si su documento RAÍZ declara el tenant en el propio bundle', () => {
    // La raíz no viene en el bundle (o es ajena) ⇒ su subárbol no puede escribirse.
    const r = contenerPathsDelBundle([linea('metaExternalIndex/whatsapp_9/sub/s1', { dato: 1 })], T);
    expect(r.ok).toBe(false);
    expect(r.violaciones[0].path).toBe('metaExternalIndex/whatsapp_9/sub/s1');
  });

  it('sin tenant no hay contención posible: se rechaza todo', () => {
    const r = contenerPathsDelBundle([linea(`tenants/${T}`, {})], '');
    expect(r.ok).toBe(false);
  });
});
