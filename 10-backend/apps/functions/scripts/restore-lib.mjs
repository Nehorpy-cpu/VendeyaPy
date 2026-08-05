/**
 * restore-lib.mjs — Las guardas que hacen que restaurar no pueda destruir.
 * ========================================================================
 * Una herramienta de restauración es, por definición, una herramienta de ESCRITURA MASIVA sobre una
 * base entera. La pregunta que decide si es segura o catastrófica no es "¿restaura bien?" sino
 * "¿puede alguien apuntarla sin querer al lugar equivocado?". Todo este módulo responde a eso.
 *
 * TRES CANDADOS, EN SERIE
 * -----------------------
 *  1. **Producción está PROHIBIDA, y no hay flag que lo levante.** No es una confirmación difícil:
 *     es una negativa. El proyecto de producción se identifica por `.firebaserc` (el alias
 *     `production`) y, además, por heurística de nombre — una heurística que solo puede RECHAZAR de
 *     más, nunca de menos, que es la única dirección en la que un falso positivo es aceptable.
 *  2. **Fuera del emulador hay que declarar el aislamiento.** Un proyecto remoto solo se acepta si
 *     el operador lo declara (`--proyecto-aislado`), el nombre tiene forma de entorno desechable
 *     **y** se escribe en una base Firestore con nombre propio (`--database`, nunca `(default)`).
 *     Tres condiciones independientes: fallar una alcanza para abortar.
 *  3. **La confirmación tiene que venir del propio destino.** `--confirmo <huella>` solo se puede
 *     completar corriendo antes la herramienta y copiando la huella que ELLA imprimió. Un operador
 *     no puede confirmar un destino que no miró.
 *
 * Y dos reglas más que no son candados sino forma:
 *   · **Cero borrado amplio.** Ninguna herramienta de esta familia borra. Los documentos del destino
 *     que no están en el backup se REPORTAN como sobrantes y se dejan intactos.
 *   · **Los conflictos se reportan antes de escribir**, con conteos y un archivo de detalle en el
 *     directorio privado. Sobrescribir es una decisión explícita, no el comportamiento por defecto.
 *
 * Módulo IMPORTABLE y sin efectos al importar.
 */
import { readFileSync } from 'node:fs';
import { huellaDestino } from './backup-lib.mjs';

/**
 * ¿Este projectId es —o parece— producción?
 *
 * Dos fuentes, unidas:
 *   · `.firebaserc`: el alias `production`/`prod` dice cuál es el proyecto productivo del repo.
 *   · el NOMBRE: cualquier projectId que contenga `prod` se trata como producción.
 *
 * La segunda es deliberadamente grosera. Un falso positivo cuesta que alguien tenga que renombrar
 * su sandbox; un falso negativo cuesta la base de producción. La asimetría manda.
 */
export function esProduccion(projectId, aliases = {}) {
  if (!projectId) return true; // sin destino identificable, se asume lo peor
  const p = String(projectId).toLowerCase();
  for (const [alias, destino] of Object.entries(aliases ?? {})) {
    if (/^(production|prod)$/i.test(alias) && String(destino).toLowerCase() === p) return true;
  }
  return /(^|[-_])prod([-_]|$)|prod[a-z0-9-]*$/.test(p) && !/^demo-/.test(p);
}

/**
 * ¿El nombre del proyecto tiene forma de entorno desechable?
 *
 * Es una condición NECESARIA, no suficiente: hay que sumarle `--proyecto-aislado` y una base con
 * nombre propio. Sirve para que un dedo resbalado sobre un projectId real no pase el filtro.
 */
export const pareceAislado = (projectId) =>
  /^demo-/.test(String(projectId ?? '')) || /(^|[-_])(restore|restauracion|dr|sandbox|scratch)([-_]|$)/.test(String(projectId ?? ''));

/**
 * Decide si se puede restaurar contra este destino. Devuelve `{ok:true}` o `{ok:false, motivo}`.
 *
 * El orden importa: primero se descarta producción (para que ningún otro flag pueda "arreglarla"),
 * después se exige aislamiento y recién al final se compara la confirmación.
 */
export function evaluarDestinoRestore({
  projectId,
  esEmulador = false,
  databaseId = '(default)',
  aliases = {},
  proyectoAislado = false,
  confirmacion = null,
}) {
  if (esProduccion(projectId, aliases)) return { ok: false, motivo: 'destino_produccion' };

  if (!esEmulador) {
    if (!proyectoAislado) return { ok: false, motivo: 'remoto_sin_declarar' };
    if (!pareceAislado(projectId)) return { ok: false, motivo: 'remoto_no_aislado' };
    if (!databaseId || databaseId === '(default)') return { ok: false, motivo: 'base_por_defecto' };
  }

  const esperada = huellaDestino({ projectId, databaseId, esEmulador });
  if (!confirmacion) return { ok: false, motivo: 'confirmacion_ausente', esperada };
  if (confirmacion !== esperada) return { ok: false, motivo: 'confirmacion_no_coincide', esperada };
  return { ok: true, huella: esperada };
}

export const AYUDA_RESTORE = {
  destino_produccion:
    'el destino es (o parece) PRODUCCIÓN. Restaurar contra producción está prohibido por esta herramienta y no hay flag que lo habilite. ' +
    'Un restore productivo es una operación con aprobación humana previa y procedimiento propio (ver docs/backup-restore.md).',
  remoto_sin_declarar:
    'el destino no es el emulador y nadie declaró que sea un entorno aislado. Agregá `--proyecto-aislado` solo si de verdad lo es.',
  remoto_no_aislado:
    'el projectId no tiene forma de entorno desechable (`demo-*`, `*-restore-*`, `*-sandbox-*`…). Restaurar sobre un proyecto con nombre de entorno real está bloqueado.',
  base_por_defecto:
    'contra un proyecto remoto hay que escribir en una base Firestore con NOMBRE PROPIO (`--database <id>`), nunca en `(default)`: la base por defecto es la que usa la aplicación.',
  confirmacion_ausente:
    'falta `--confirmo <huella>`. Corré la herramienta sin `--apply`: imprime la huella del destino, y copiarla es la prueba de que lo miraste.',
  confirmacion_no_coincide:
    'la huella de `--confirmo` no corresponde a este destino. Es exactamente el caso que la confirmación existe para atrapar: se copió la huella de OTRO destino.',
};

// ---------------------------------------------------------------------------
// Contención de caminos que vienen DEL BUNDLE (correctivo release-safety)
// ---------------------------------------------------------------------------

/**
 * ¿Un camino que viene del bundle (nombre de objeto de Storage o path de documento de Firestore)
 * tiene estructura sana? Un bundle es un archivo en disco: nada garantiza su procedencia, así que
 * NADA de lo que trae puede convertirse en una ruta sin pasar por acá primero.
 *
 * Rechaza: no-strings, vacío, backslashes (en Windows `\` también navega), absolutos (primer
 * segmento vacío), `.` y `..` (traversal), y segmentos vacíos (`//`, barra final).
 */
export function caminoSano(camino) {
  if (typeof camino !== 'string' || camino.length === 0) return false;
  if (camino.includes('\\')) return false;
  return camino.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// Lectura del volcado
// ---------------------------------------------------------------------------

/** Lee un NDJSON a array, rechazando líneas corruptas con el número de línea. */
export function leerNdjson(path) {
  const texto = readFileSync(path, 'utf8');
  const out = [];
  let n = 0;
  for (const linea of texto.split('\n')) {
    n += 1;
    if (!linea.trim()) continue;
    try { out.push(JSON.parse(linea)); } catch { throw new Error(`[restore] volcado corrupto: línea ${n} de ${path} no es JSON válido.`); }
  }
  return out;
}

/**
 * Verifica que el volcado sea el que dice el manifiesto y del formato que esta herramienta entiende.
 *
 * Restaurar un archivo cuyo hash no coincide con su manifiesto es restaurar algo que se modificó
 * después del backup — y nadie sabe qué. Se aborta.
 */
export function verificarManifiesto({ manifiesto, sha256Archivo, formatoEsperado }) {
  if (!manifiesto || manifiesto.formato !== formatoEsperado) {
    return { ok: false, motivo: `formato desconocido: ${manifiesto?.formato ?? '(ausente)'} (esperado ${formatoEsperado})` };
  }
  if (manifiesto.aplicado !== true) return { ok: false, motivo: 'el manifiesto dice que el backup fue un DRY-RUN: no hay datos que restaurar.' };
  if (manifiesto.sha256 && manifiesto.sha256 !== sha256Archivo) {
    return { ok: false, motivo: 'el sha256 del volcado NO coincide con el del manifiesto: el archivo cambió después del backup.' };
  }
  return { ok: true };
}

/**
 * Clasifica cada documento del volcado contra el destino: ausente / idéntico / divergente.
 *
 * `hashActual` viene de aplicar la MISMA función de hash canónico que usó el backup, así que
 * "idéntico" significa idéntico de verdad y no "parecido". Sin esta clasificación, un restore es
 * un `set()` masivo a ciegas sobre datos que quizá ya eran correctos.
 */
export function clasificarConflictos(lineas, hashesActuales) {
  const ausentes = [];
  const identicos = [];
  const divergentes = [];
  for (const l of lineas) {
    if (!l.existe) continue; // padre fantasma: no se escribe documento
    const actual = hashesActuales.get(l.path);
    if (actual === undefined) ausentes.push(l.path);
    else if (actual === l.hash) identicos.push(l.path);
    else divergentes.push(l.path);
  }
  return { ausentes, identicos, divergentes };
}
