/**
 * backup-storage.mjs — Inventario verificable de los objetos de Storage de un tenant.
 * ===================================================================================
 * QUÉ RESPALDA Y QUÉ NO, SIN AMBIGÜEDAD
 * -------------------------------------
 * Respalda el **inventario**: nombre, tamaño, contentType, checksums (`md5Hash`/`crc32c`),
 * `generation` (o sea, las VERSIONES cuando el bucket las conserva) y fechas. **No copia los
 * bytes.** La razón no es pereza: los bytes de `tenants/{id}/attachments/**` son fotos y PDF que
 * mandaron clientes reales, y duplicarlos a un directorio local multiplica la superficie de un dato
 * que las reglas de Storage tienen cerrado a cal y canto (`read, write: if false`). Copiarlos es
 * una decisión de negocio con consecuencias de privacidad, no un default.
 *
 * Lo que sí hace es **demostrar que los bytes están y están íntegros**: con `--muestra N` descarga
 * N objetos, recalcula el MD5 en memoria, lo compara contra el `md5Hash` que declara el bucket y
 * **descarta el contenido sin escribirlo**. Un inventario que nadie verificó es una lista de
 * nombres; esto es evidencia.
 *
 * Consecuencia que va escrita en el manifiesto: **un restore de Firestore sin los objetos deja
 * adjuntos y comprobantes ROTOS** — el documento apunta a una ruta que ya no existe. Para los
 * bytes, la herramienta correcta es la copia de objetos del propio proveedor (`gcloud storage rsync`
 * / Object Versioning), y el inventario de acá es lo que permite comprobar que esa copia está
 * completa.
 *
 * SEGURIDAD
 *   Proyecto y tenant obligatorios · DRY-RUN por defecto · salida absoluta fuera del repo ·
 *   manifiesto con conteos y hashes · **jamás se genera ni se loguea una URL firmada** · los
 *   nombres de objeto van completos al archivo privado y por HUELLA al log.
 *
 * USO
 *   node scripts/backup-storage.mjs --project <id> --tenant <id> --out <dir absoluto> [--bucket <b>] [--muestra 5] [--apply]
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
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
  const { projectId, esEmulador } = destino;
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

  const muestra = elegirMuestra(objetos, muestraN);
  const verificaciones = [];
  for (const o of muestra) verificaciones.push(await verificarObjeto(bucket, o));
  const fallidas = verificaciones.filter((v) => !v.ok);

  prepararSalida(salida.path);
  const archivo = join(salida.path, 'storage.ndjson');
  writeFileSync(archivo, `${objetos.map((o) => JSON.stringify(o)).join('\n')}\n`, { mode: 0o600 });

  const manifiesto = {
    ...manifiestoBase({ herramienta: 'backup-storage', projectId, esEmulador, tenantId, aplicado: true }),
    archivo: 'storage.ndjson',
    bucket: bucketName,
    prefijo: prefijoTenant(tenantId),
    sha256: sha256(readFileSync(archivo)),
    hashInventario: hashInventario(objetos),
    resumen,
    muestreo: { pedidos: muestraN, verificados: verificaciones.length, fallidos: fallidas.length, detalle: verificaciones },
    alcance:
      'INVENTARIO, no copia de bytes. Un restore de Firestore sin los objetos deja adjuntos y ' +
      'comprobantes rotos: el documento apunta a una ruta inexistente. Los bytes se copian con la ' +
      'herramienta del proveedor; este inventario es lo que permite verificar que esa copia está completa.',
  };
  writeFileSync(join(salida.path, 'manifest-storage.json'), `${JSON.stringify(manifiesto, null, 2)}\n`, { mode: 0o600 });

  if (fallidas.length > 0) {
    throw new Error(`[backup-storage] ABORTADO: ${fallidas.length} de ${verificaciones.length} objetos de la muestra NO verificaron checksum/tamaño. El inventario quedó escrito para diagnóstico.`);
  }
  console.log(`[backup-storage] OK → ${salida.path} (${resumen.total} objetos, ${verificaciones.length} verificados por checksum)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
