/**
 * backup-lib.mjs — Núcleo compartido de las herramientas de backup y restauración.
 * ================================================================================
 * Por qué existe esta familia de scripts: hasta hoy el repo NO tenía ninguna herramienta de
 * restauración, y `export-tenant.mjs` —lo único parecido a un backup— no es restaurable. La
 * auditoría del programa lo dejó por escrito y este módulo cablea cada una de esas lecciones:
 *
 *  1. **La lista de colecciones no puede ser un dato del autor.** `export-tenant.mjs` enumera 15
 *     nombres a mano; todo lo que no esté en esa lista —sesiones, mensajes, ítems de pedido, y
 *     cualquier colección futura— desaparece del "backup" en silencio. Acá el descubrimiento es
 *     del SISTEMA: `listCollections()` recursivo (ver `backup-firestore.mjs`).
 *  2. **Un backup que degrada tipos no es un backup.** `{...d.data()}` convierte un `Timestamp` en
 *     `{_seconds,_nanoseconds}`, un `GeoPoint` en `{_latitude,_longitude}` y unos `Bytes` en un
 *     objeto raro. Restaurar eso deja un documento que ya no es el original. Acá la serialización
 *     es TIPADA y round-trippable (`codificar`/`decodificar`).
 *  3. **Sin el ciphertext de `secrets/`, un restore deja las conexiones MUERTAS.** Las conexiones
 *     Meta guardan `secret://firestore/<name>`; el valor vive cifrado en la colección global
 *     `secrets` (`lib/secretStore.ts`). Se respalda el CIPHERTEXT y la referencia. **Nunca el
 *     plaintext**, y nunca se descifra nada acá.
 *  4. **Los datos privados no van adentro del repo.** El exportador escribía el JSON en el árbol
 *     del repo, sin gitignore. Acá el destino es obligatorio, absoluto y FUERA del repo.
 *  5. **Salir con 0 pase lo que pase es peor que fallar.** Todo camino de error termina en exit ≠ 0.
 *
 * Nada de este módulo imprime teléfonos, wa_ids, mensajes, coordenadas, URLs firmadas ni valores de
 * secretos: los identificadores se loguean por HUELLA (`huella()`), que es irreversible.
 *
 * Módulo IMPORTABLE y sin efectos al importar (mismo patrón que `build-deploy.mjs`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, sep, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timestamp, GeoPoint, DocumentReference } from 'firebase-admin/firestore';

/** Versión del FORMATO de los volcados. Un restore se niega a leer un formato que no conoce. */
export const FORMATO = 'vpw-backup/1';

// ---------------------------------------------------------------------------
// Higiene de logs
// ---------------------------------------------------------------------------

/**
 * Huella irreversible de un identificador, para poder LOGUEAR sin filtrar.
 *
 * Un backup toca tenantIds, wa_ids, uids, rutas de documento y nombres de objetos de Storage: todo
 * eso identifica personas. Loguear la huella permite correlacionar dos líneas del mismo run sin
 * publicar el dato. 12 hex alcanzan para distinguir y no alcanzan para revertir.
 */
export function huella(valor) {
  return createHash('sha256').update(String(valor ?? ''), 'utf8').digest('hex').slice(0, 12);
}

/** SHA-256 completo, en hex. Se usa para los hashes del manifiesto. */
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Serialización TIPADA y round-trippable
// ---------------------------------------------------------------------------

const ETIQUETA = '$vpw';

/** ¿Este objeto plano necesita escaparse porque su clave colisiona con la etiqueta? */
const necesitaEscape = (obj) => Object.prototype.hasOwnProperty.call(obj, ETIQUETA);

/**
 * Codifica un valor de Firestore a JSON puro, SIN perder el tipo.
 *
 * El defecto que cierra: `{ id, ...d.data() }` pasa por `JSON.stringify` y ahí un `Timestamp` se
 * vuelve `{_seconds,_nanoseconds}` — un mapa cualquiera, indistinguible de un mapa que el negocio
 * hubiera escrito así. Al restaurar, el campo deja de ser una fecha: las consultas por rango, los
 * TTL y los ordenamientos dejan de funcionar, y nadie se entera porque el documento "está".
 *
 * Formas emitidas (todas objetos con la clave `$vpw`):
 *   · `{$vpw:'ts', s, ns}`      — Timestamp
 *   · `{$vpw:'geo', lat, lng}`  — GeoPoint
 *   · `{$vpw:'bytes', b64}`     — Bytes / Buffer
 *   · `{$vpw:'ref', path}`      — DocumentReference (ruta relativa a la base)
 *   · `{$vpw:'num', v}`         — NaN / Infinity / -Infinity (JSON los volvería `null`)
 *   · `{$vpw:'map', v}`         — mapa del negocio que YA contenía la clave `$vpw` (escape)
 */
export function codificar(valor) {
  if (valor === null || valor === undefined) return null;
  const t = typeof valor;
  if (t === 'string' || t === 'boolean') return valor;
  if (t === 'number') {
    if (Number.isNaN(valor)) return { [ETIQUETA]: 'num', v: 'NaN' };
    if (valor === Infinity) return { [ETIQUETA]: 'num', v: 'Infinity' };
    if (valor === -Infinity) return { [ETIQUETA]: 'num', v: '-Infinity' };
    return valor;
  }
  if (valor instanceof Timestamp) return { [ETIQUETA]: 'ts', s: valor.seconds, ns: valor.nanoseconds };
  if (valor instanceof GeoPoint) return { [ETIQUETA]: 'geo', lat: valor.latitude, lng: valor.longitude };
  if (valor instanceof DocumentReference) return { [ETIQUETA]: 'ref', path: valor.path };
  if (Buffer.isBuffer(valor)) return { [ETIQUETA]: 'bytes', b64: valor.toString('base64') };
  if (valor instanceof Uint8Array) return { [ETIQUETA]: 'bytes', b64: Buffer.from(valor).toString('base64') };
  if (valor instanceof Date) return { [ETIQUETA]: 'ts', s: Math.floor(valor.getTime() / 1000), ns: (valor.getTime() % 1000) * 1e6 };
  if (Array.isArray(valor)) return valor.map(codificar);
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = codificar(v);
    // Escape: un mapa del NEGOCIO que ya tenía `$vpw` se envuelve, para que el decoder no lo
    // confunda con una forma tipada. Sin esto, un dato inocente rompería la restauración.
    return necesitaEscape(valor) ? { [ETIQUETA]: 'map', v: out } : out;
  }
  throw new Error(`[backup] tipo no serializable: ${t}`);
}

/**
 * Inverso exacto de `codificar`. `refFactory` reconstruye los DocumentReference contra la base
 * DESTINO; sin ella se devuelve un marcador inerte (sirve para tests puros y para inspección).
 */
export function decodificar(valor, { refFactory = (path) => ({ refSinResolver: path }) } = {}) {
  if (valor === null || valor === undefined) return null;
  const t = typeof valor;
  if (t === 'string' || t === 'boolean' || t === 'number') return valor;
  if (Array.isArray(valor)) return valor.map((v) => decodificar(v, { refFactory }));
  if (t !== 'object') return valor;

  const etiqueta = valor[ETIQUETA];
  if (typeof etiqueta === 'string') {
    switch (etiqueta) {
      case 'ts': return new Timestamp(valor.s, valor.ns);
      case 'geo': return new GeoPoint(valor.lat, valor.lng);
      case 'bytes': return Buffer.from(valor.b64, 'base64');
      case 'ref': return refFactory(valor.path);
      case 'num': return valor.v === 'NaN' ? NaN : valor.v === 'Infinity' ? Infinity : -Infinity;
      case 'map': {
        const out = {};
        for (const [k, v] of Object.entries(valor.v ?? {})) out[k] = decodificar(v, { refFactory });
        return out;
      }
      default: throw new Error(`[backup] etiqueta desconocida en el volcado: ${etiqueta}`);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(valor)) out[k] = decodificar(v, { refFactory });
  return out;
}

/**
 * JSON CANÓNICO: claves ordenadas en todo el árbol. Es lo que se hashea.
 *
 * Sin canonicalizar, dos volcados idénticos con las claves en otro orden darían hashes distintos y
 * la prueba de equivalencia backup↔restore sería ruido. Firestore no garantiza orden de campos.
 */
export function canonico(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor ?? null);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  const claves = Object.keys(valor).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
}

/** Hash de contenido de un documento YA codificado. Independiente del orden de campos. */
export const hashDoc = (encoded) => sha256(Buffer.from(canonico(encoded), 'utf8'));

// ---------------------------------------------------------------------------
// Destino: proyecto (obligatorio, jamás ambiguo)
// ---------------------------------------------------------------------------

/** Forma válida de un projectId de GCP (idéntica a la de `build-deploy.mjs`). */
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{3,28}[a-z0-9]$/;

/**
 * Resuelve el proyecto contra el que va a operar la herramienta.
 *
 * Reglas, y cada una tiene una víctima concreta detrás:
 *  · `--project` es OBLIGATORIO. `export-tenant.mjs` caía al emulador en silencio cuando faltaba
 *    todo, así que un operador podía creer que respaldó producción y llevarse un archivo vacío.
 *  · `--project` repetido es ERROR, no "gana el último" (misma lección que `deploy-guard.mjs`).
 *  · Si `GCLOUD_PROJECT` contradice a `--project`, es AMBIGUO y se aborta. Dos fuentes que dicen
 *    cosas distintas sobre a qué base se escribe no se resuelven eligiendo una.
 *  · El emulador se DECLARA (`FIRESTORE_EMULATOR_HOST`), nunca se infiere. Se devuelve el hecho
 *    para que cada herramienta decida: el backup lo permite, el restore lo EXIGE.
 */
export function resolverDestino({ env = {}, argv = [] } = {}) {
  const explicitos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') explicitos.push(argv[i + 1]);
    else if (typeof argv[i] === 'string' && argv[i].startsWith('--project=')) explicitos.push(argv[i].slice('--project='.length));
  }
  if (explicitos.length > 1) return { ok: false, motivo: 'proyecto_ambiguo' };
  if (explicitos.length === 0) return { ok: false, motivo: 'proyecto_ausente' };

  const projectId = explicitos[0];
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return { ok: false, motivo: 'proyecto_invalido' };

  const delEntorno = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (delEntorno && delEntorno !== projectId) return { ok: false, motivo: 'proyecto_ambiguo' };

  const emulador = env.FIRESTORE_EMULATOR_HOST ?? null;
  return { ok: true, projectId, emulador, esEmulador: Boolean(emulador) };
}

export const AYUDA_DESTINO = {
  proyecto_ausente: 'falta `--project <projectId>`. La herramienta NO adivina el destino ni cae al emulador en silencio.',
  proyecto_ambiguo: '`--project` repetido, o GCLOUD_PROJECT contradice a `--project`. Un run pertenece a UN destino.',
  proyecto_invalido: 'el projectId no tiene forma válida de proyecto GCP.',
};

/**
 * Huella del DESTINO, para que el operador pueda confirmarlo copiándola.
 *
 * No es criptografía: es una etiqueta corta que solo se puede obtener CORRIENDO la herramienta
 * contra ese destino. Confirmar tipeando la huella demuestra que el operador vio a dónde apunta.
 */
export const huellaDestino = ({ projectId, databaseId = '(default)', esEmulador }) =>
  huella(`${projectId}|${databaseId}|${esEmulador ? 'emulador' : 'remoto'}`);

// ---------------------------------------------------------------------------
// Destino: directorio de salida (absoluto, fuera del repo, privado)
// ---------------------------------------------------------------------------

const AQUI = dirname(fileURLToPath(import.meta.url)); // apps/functions/scripts
/** Raíz del monorepo (`10-backend`) y raíz del repo git (`AI_AFG`). */
export const RAIZ_BACKEND = resolve(AQUI, '..', '..', '..');
export const RAIZ_REPO = resolve(RAIZ_BACKEND, '..');

const dentroDe = (hijo, padre) => {
  const p = resolve(padre) + sep;
  const h = resolve(hijo) + sep;
  return h.startsWith(p);
};

/**
 * Valida el destino de salida. Devuelve `{ok, path}` o `{ok:false, motivo}`.
 *
 * El exportador escribía `perfumeria-export.json` en el cwd — o sea, típicamente adentro del repo,
 * con datos de clientes reales, sin ninguna regla de `.gitignore` que lo cubriera. Un `git add -A`
 * distraído lo commiteaba. Acá:
 *   · la ruta tiene que ser ABSOLUTA (una relativa depende del cwd, que es exactamente cómo se
 *     coló adentro del repo);
 *   · tiene que estar FUERA del repo git, no solo fuera de `10-backend`;
 *   · si existe, tiene que ser un directorio.
 */
export function validarSalida(out, { raizRepo = RAIZ_REPO } = {}) {
  if (!out || typeof out !== 'string') return { ok: false, motivo: 'salida_ausente' };
  if (!isAbsolute(out)) return { ok: false, motivo: 'salida_relativa' };
  const path = resolve(out);
  if (dentroDe(path, raizRepo) || path === resolve(raizRepo)) return { ok: false, motivo: 'salida_en_repo' };
  if (existsSync(path) && !statSync(path).isDirectory()) return { ok: false, motivo: 'salida_no_es_directorio' };
  return { ok: true, path };
}

export const AYUDA_SALIDA = {
  salida_ausente: 'falta `--out <directorio absoluto>`.',
  salida_relativa: '`--out` tiene que ser una ruta ABSOLUTA: una relativa depende del cwd y así fue como los datos privados terminaron adentro del repo.',
  salida_en_repo: '`--out` apunta ADENTRO del repo. Un backup contiene datos de clientes reales y no se versiona jamás.',
  salida_no_es_directorio: '`--out` existe y no es un directorio.',
};

/** Crea el directorio de salida lo más restringido que permita el SO. */
export function prepararSalida(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

/** Lee `--flag valor` o `--flag=valor`. Repetido ⇒ `{ ambiguo:true }` (nunca "gana el último"). */
export function leerFlag(argv, nombre) {
  const vals = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${nombre}`) vals.push(argv[i + 1]);
    else if (typeof argv[i] === 'string' && argv[i].startsWith(`--${nombre}=`)) vals.push(argv[i].slice(nombre.length + 3));
  }
  if (vals.length > 1) return { ambiguo: true, valor: null };
  return { ambiguo: false, valor: vals.length ? vals[0] : null };
}

export const tieneFlag = (argv, nombre) => argv.includes(`--${nombre}`);

/** `--apply` enciende los efectos. Sin él, DRY-RUN: se recorre y se cuenta, no se escribe nada. */
export const esAplicar = (argv) => tieneFlag(argv, 'apply');

// ---------------------------------------------------------------------------
// Advertencias que TIENEN que viajar con cada manifiesto
// ---------------------------------------------------------------------------

/**
 * Los límites de un restore de Firebase, escritos en el propio artefacto.
 *
 * Van en el MANIFIESTO —no solo en el runbook— porque el runbook se lee antes del incidente y el
 * manifiesto se lee DURANTE. Los tres primeros puntos son la diferencia entre "restauramos" y
 * "restauramos Firebase": lo de afuera de Firebase no vuelve.
 */
export const ADVERTENCIAS = [
  'RESTAURAR FIREBASE NO DESHACE CAMBIOS EXTERNOS. Un restore repone documentos, usuarios y objetos: no revierte nada que Meta ya haya hecho ni nada que la app WhatsApp Business del vendedor haya hecho en su teléfono.',
  'UN RESTORE NO DES-ONBOARDEA UN NÚMERO. Si el número real entró en Coexistence, sigue onboardeado después del restore; desconectarlo es un acto del cliente desde su app (la Deregister API está prohibida en coexistencia, ADR-0017 §6).',
  'EL ESTADO EXTERNO PUEDE QUEDAR ADELANTADO. Tras un restore, `automationMode`, los assets y el índice de ruteo vuelven al momento del backup aunque Meta ya haya emitido `account_update`; hay que reconciliar contra Meta antes de volver a `live`.',
  'UN BACKUP GESTIONADO DE FIRESTORE RETIENE HASTA 14 SEMANAS. Choca con el TTL de 48 h del archivo de Coexistence: el dato que el TTL borra a las 48 h sigue existiendo dentro del backup gestionado por semanas. Tenerlo en cuenta al responder un pedido de borrado.',
  'UN RESTORE NO REPONE LAS POLÍTICAS TTL. Las políticas de time-to-live son configuración de la base, no datos: si se restaura sobre una base nueva hay que volver a crearlas, o las colecciones con TTL dejan de purgarse y crecen sin límite.',
  'LOS SECRETOS SE RESPALDAN CIFRADOS. Sin la clave de cifrado del entorno (`TENANT_SECRETS_ENCRYPTION_KEY`), el ciphertext restaurado no sirve: la clave NO está en el backup y hay que reponerla aparte.',
];

/** Esqueleto común del manifiesto. Cada herramienta le agrega sus conteos y hashes. */
export function manifiestoBase({ herramienta, projectId, esEmulador, tenantId, aplicado }) {
  return {
    formato: FORMATO,
    herramienta,
    creadoEn: new Date().toISOString(),
    destino: { projectId, esEmulador: Boolean(esEmulador), huella: huellaDestino({ projectId, esEmulador }) },
    // El tenantId va COMPLETO en el manifiesto (el archivo es privado y hay que saber qué contiene)
    // y por HUELLA en los logs (que no lo son).
    tenantId: tenantId ?? null,
    aplicado: Boolean(aplicado),
    advertencias: ADVERTENCIAS,
  };
}
