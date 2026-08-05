/**
 * backup-storage.mjs — COPIA COMPLETA y verificable de los objetos de Storage de un tenant.
 * =========================================================================================
 * QUÉ RESPALDA, SIN AMBIGÜEDAD
 * ----------------------------
 * Con `--apply` **copia TODOS los bytes** del prefijo del tenant (incluidas las versiones no
 * vigentes cuando el bucket las conserva) a un directorio privado FUERA del repo, más el
 * inventario: nombre, tamaño, contentType, checksums (`md5Hash`/`crc32c`), `generation` y fechas.
 * Cada objeto se verifica al copiar (md5 y tamaño contra lo que declara el bucket — verificación
 * COMPLETA, no una muestra) y su sha256 queda en el NDJSON: es lo que `restore-storage.mjs`
 * re-verifica antes de subir y lo que la prueba de equivalencia compara al final.
 *
 * La versión anterior de esta herramienta era SOLO un inventario, y esa media verdad costaba
 * caro: un restore de Firestore sin los objetos deja adjuntos y comprobantes ROTOS — el documento
 * apunta a una ruta que ya no existe. Los backups viejos (sin `copiaDeBytes: true` en el manifest)
 * siguen siendo inventarios y el restore los rechaza con esa explicación.
 *
 * PRIVACIDAD: los bytes de `tenants/{id}/attachments/**` son fotos y PDF de clientes reales. El
 * destino es OBLIGATORIAMENTE una ruta absoluta fuera del repo (jamás commiteable), los archivos
 * nacen con permisos 0600 y los logs solo llevan huellas — nunca nombres completos ni URLs
 * firmadas. El manifiesto deja escrito que restaurar Firebase NO deshace cambios externos.
 *
 * SEGURIDAD
 *   Proyecto y tenant obligatorios · DRY-RUN por defecto (lista y cuenta; no descarga) · salida
 *   absoluta fuera del repo · manifiesto con conteos y hashes · abortar ante cualquier objeto que
 *   no verifique. `--muestra` se acepta por compatibilidad pero es inerte: la verificación es total.
 *
 * USO
 *   node scripts/backup-storage.mjs --project <id> --tenant <id> --out <dir absoluto> [--bucket <b>] [--apply]
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { nombreLocalDeObjeto } from './restore-storage.mjs';
import {
  huella, sha256, canonico, resolverDestino, AYUDA_DESTINO, validarSalida, AYUDA_SALIDA,
  prepararSalida, leerFlag, esAplicar, manifiestoBase,
} from './backup-lib.mjs';

// ---------------------------------------------------------------------------
// Lógica PURA
// ---------------------------------------------------------------------------

/** Prefijo de los objetos de un tenant (ver `storage.rules`: todo cuelga de `tenants/{id}/`). */
export const prefijoTenant = (tenantId) => `tenants/${tenantId}/`;

/** Familia funcional del objeto, derivada de la ruta. Sirve para contar sin exponer nombres. */
export function familiaDeRuta(nombre) {
  const m = /^tenants\/[^/]+\/([^/]+)\//.exec(nombre);
  return m ? m[1] : '(raíz del tenant)';
}

/** Proyección serializable de un objeto. Nunca incluye bytes ni URLs. */
export const proyectarObjeto = (f) => ({
  nombre: f.name,
  familia: familiaDeRuta(f.name),
  generation: String(f.metadata?.generation ?? ''),
  tamano: Number(f.metadata?.size ?? 0),
  contentType: f.metadata?.contentType ?? null,
  md5: f.metadata?.md5Hash ?? null,
  crc32c: f.metadata?.crc32c ?? null,
  creadoEn: f.metadata?.timeCreated ?? null,
  actualizadoEn: f.metadata?.updated ?? null,
  // `timeDeleted` presente ⇒ es una versión NO vigente que el bucket todavía conserva.
  eliminadoEn: f.metadata?.timeDeleted ?? null,
});

/** Conteos por familia y por vigencia. Es lo que se compara antes y después de un restore. */
export function resumirObjetos(objetos) {
  const porFamilia = {};
  let bytes = 0;
  let versionesNoVigentes = 0;
  for (const o of objetos) {
    porFamilia[o.familia] = (porFamilia[o.familia] ?? 0) + 1;
    bytes += o.tamano;
    if (o.eliminadoEn) versionesNoVigentes += 1;
  }
  return {
    total: objetos.length,
    bytes,
    versionesNoVigentes,
    vigentes: objetos.length - versionesNoVigentes,
    porFamilia: Object.fromEntries(Object.entries(porFamilia).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Hash del inventario completo (orden estable): un solo valor para comparar dos corridas. */
export const hashInventario = (objetos) =>
  sha256(Buffer.from(canonico([...objetos].sort((a, b) => `${a.nombre}#${a.generation}`.localeCompare(`${b.nombre}#${b.generation}`))), 'utf8'));

/**
 * Elige la muestra de forma DETERMINÍSTICA (no aleatoria) y repartida entre familias.
 *
 * Determinística porque una muestra al azar no se puede reproducir: si una corrida encuentra un
 * objeto corrupto y la siguiente no lo elige, el hallazgo desaparece. Repartida entre familias
 * porque muestrear 5 objetos y que los 5 caigan en `products/` no dice nada sobre `attachments/`.
 */
export function elegirMuestra(objetos, n) {
  if (n <= 0) return [];
  const vigentes = objetos.filter((o) => !o.eliminadoEn);
  const porFamilia = new Map();
  for (const o of vigentes) {
    if (!porFamilia.has(o.familia)) porFamilia.set(o.familia, []);
    porFamilia.get(o.familia).push(o);
  }
  for (const lista of porFamilia.values()) lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
  const familias = [...porFamilia.keys()].sort();
  const out = [];
  for (let vuelta = 0; out.length < n; vuelta += 1) {
    let agrego = false;
    for (const f of familias) {
      const lista = porFamilia.get(f);
      if (vuelta < lista.length && out.length < n) { out.push(lista[vuelta]); agrego = true; }
    }
    if (!agrego) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

/** Descarga un objeto en memoria y comprueba su MD5 contra el que declara el bucket. */
export async function verificarObjeto(bucket, o) {
  try {
    const [buf] = await bucket.file(o.nombre, o.generation ? { generation: o.generation } : undefined).download();
    const md5 = createHash('md5').update(buf).digest('base64');
    return {
      objeto: huella(o.nombre),
      bytesLeidos: buf.length,
      tamanoDeclarado: o.tamano,
      md5Coincide: o.md5 ? md5 === o.md5 : null,
      // El sha256 del contenido queda como evidencia comparable sin guardar el contenido.
      sha256: sha256(buf),
      ok: (o.md5 ? md5 === o.md5 : true) && buf.length === o.tamano,
    };
  } catch (e) {
    return { objeto: huella(o.nombre), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(argv, env) {
  const destino = resolverDestino({ env, argv });
  if (!destino.ok) throw new Error(`[backup-storage] ABORTADO (${destino.motivo}): ${AYUDA_DESTINO[destino.motivo]}`);

  const tenantFlag = leerFlag(argv, 'tenant');
  if (tenantFlag.ambiguo) throw new Error('[backup-storage] ABORTADO: `--tenant` repetido.');
  const tenantId = tenantFlag.valor;
  if (!tenantId) throw new Error('[backup-storage] ABORTADO: falta `--tenant <id>`.');

  const outFlag = leerFlag(argv, 'out');
  if (outFlag.ambiguo) throw new Error('[backup-storage] ABORTADO: `--out` repetido.');
  const salida = validarSalida(outFlag.valor);
  if (!salida.ok) throw new Error(`[backup-storage] ABORTADO (${salida.motivo}): ${AYUDA_SALIDA[salida.motivo]}`);

  const bucketFlag = leerFlag(argv, 'bucket');
  if (bucketFlag.ambiguo) throw new Error('[backup-storage] ABORTADO: `--bucket` repetido.');
  const muestraFlag = leerFlag(argv, 'muestra');
  const muestraN = muestraFlag.valor === null ? 0 : Number(muestraFlag.valor);
  if (!Number.isInteger(muestraN) || muestraN < 0) throw new Error('[backup-storage] ABORTADO: `--muestra` tiene que ser un entero ≥ 0.');

  const aplicar = esAplicar(argv);
  const { projectId } = destino;
  // Correctivo (MEDIO 21): una herramienta de STORAGE decide «emulador» por la variable del
  // emulador de STORAGE. resolverDestino mira FIRESTORE_EMULATOR_HOST, que acá es la señal
  // equivocada: con solo Firestore emulado, esta herramienta hablaría con el bucket REAL creyendo
  // que está en el emulador.
  const esEmulador = Boolean(env.STORAGE_EMULATOR_HOST || env.FIREBASE_STORAGE_EMULATOR_HOST);
  const bucketName = bucketFlag.valor ?? `${projectId}.firebasestorage.app`;
  if (!getApps().length) {
    initializeApp({
      ...(env.GOOGLE_APPLICATION_CREDENTIALS && !esEmulador ? { credential: applicationDefault() } : {}),
      projectId,
      storageBucket: bucketName,
    });
  }

  console.log(`[backup-storage] destino=${projectId} bucket#${huella(bucketName)} tenant#${huella(tenantId)} modo=${aplicar ? 'APPLY' : 'DRY-RUN'}`);

  const bucket = getStorage().bucket(bucketName);
  const [archivos] = await bucket.getFiles({ prefix: prefijoTenant(tenantId), versions: true });
  const objetos = archivos.map(proyectarObjeto);
  const resumen = resumirObjetos(objetos);

  if (!aplicar) {
    console.log(`[backup-storage] DRY-RUN: ${resumen.total} objetos (${resumen.vigentes} vigentes, ${resumen.versionesNoVigentes} versiones antiguas), ${resumen.bytes} bytes.`);
    console.log('[backup-storage] por familia:', JSON.stringify(resumen.porFamilia));
    console.log('[backup-storage] nada escrito ni descargado. Repetir con `--apply`.');
    return;
  }

  prepararSalida(salida.path);
  const dirObjetos = join(salida.path, 'objetos');
  mkdirSync(dirObjetos, { recursive: true, mode: 0o700 });

  /**
   * COPIA DE BYTES, objeto por objeto — el correctivo lo dijo sin vueltas: «no llamar backup
   * restaurable completo a un inventario». Cada objeto se descarga entero, se recalcula el MD5
   * contra el que declara el bucket (verificación COMPLETA, ya no una muestra) y se guarda bajo un
   * nombre plano determinístico (hash de ruta+generación: un `../` hostil en el nombre del bucket
   * no puede salirse del directorio). El sha256 del contenido viaja en el NDJSON: es lo que el
   * restore verifica ANTES de subir y lo que la equivalencia del E2E compara al final.
   */
  const lineas = [];
  const fallidas = [];
  let bytesCopiados = 0;
  for (const o of objetos) {
    try {
      const fuente = bucket.file(o.nombre, o.generation ? { generation: o.generation } : undefined);
      const [buf] = await fuente.download();
      const md5 = createHash('md5').update(buf).digest('base64');
      if (o.md5 && md5 !== o.md5) {
        fallidas.push({ objeto: huella(o.nombre), motivo: 'md5 descargado ≠ md5 declarado por el bucket' });
        continue;
      }
      if (buf.length !== o.tamano) {
        fallidas.push({ objeto: huella(o.nombre), motivo: `tamaño descargado ${buf.length} ≠ declarado ${o.tamano}` });
        continue;
      }
      const archivoLocal = nombreLocalDeObjeto(o.nombre, o.generation);
      writeFileSync(join(dirObjetos, archivoLocal), buf, { mode: 0o600 });
      bytesCopiados += buf.length;
      lineas.push({ ...o, archivoLocal, sha256Contenido: createHash('sha256').update(buf).digest('hex') });
    } catch (e) {
      fallidas.push({ objeto: huella(o.nombre), motivo: e instanceof Error ? e.message : String(e) });
    }
  }

  const archivo = join(salida.path, 'storage.ndjson');
  writeFileSync(archivo, `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });

  const manifiesto = {
    ...manifiestoBase({ herramienta: 'backup-storage', projectId, esEmulador, tenantId, aplicado: true }),
    archivo: 'storage.ndjson',
    bucket: bucketName,
    prefijo: prefijoTenant(tenantId),
    copiaDeBytes: true,
    sha256: sha256(readFileSync(archivo)),
    hashInventario: hashInventario(objetos),
    resumen,
    copia: { esperados: objetos.length, copiados: lineas.length, bytes: bytesCopiados, fallidos: fallidas.length, detalleFallidos: fallidas },
    alcance:
      'COPIA COMPLETA de bytes del prefijo del tenant, con verificación md5/tamaño por objeto y ' +
      'sha256 del contenido en el NDJSON. Se restaura con restore-storage.mjs (emulador o destino ' +
      'aislado; producción prohibida). Restaurar Firebase NO deshace cambios externos de Meta ni de la app móvil.',
  };
  writeFileSync(join(salida.path, 'manifest-storage.json'), `${JSON.stringify(manifiesto, null, 2)}\n`, { mode: 0o600 });

  if (fallidas.length > 0) {
    throw new Error(`[backup-storage] ABORTADO: ${fallidas.length} de ${objetos.length} objetos NO se pudieron copiar/verificar. El manifest quedó escrito para diagnóstico.`);
  }
  console.log(`[backup-storage] OK → ${salida.path} (${lineas.length} objetos copiados, ${bytesCopiados} bytes, verificación completa por md5+tamaño)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
