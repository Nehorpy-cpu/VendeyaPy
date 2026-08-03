/**
 * deploy-guard.mjs — Guardia FAIL-CLOSED de las rutas ejecutables de deploy.
 * =========================================================================
 * Por qué existe: el release del modelo de propiedad (2026-07-31) mostró que el comando de deploy
 * que estaba documentado —un `--only functions` sin selector— habría CREADO en producción una
 * función que nunca debe existir allí, y que varios scripts del repo apuntaban al proyecto
 * equivocado o dependían en silencio del `default` de `.firebaserc` (que es `vpw-dev`).
 *
 * Dos responsabilidades, a propósito separadas:
 *  1. `validarArgsDeploy(argv, {aliases})` — PURA. Decide si UNA invocación es segura. La usa
 *     `firebase-deploy.mjs` antes de ejecutar nada, y los tests con casos sintéticos.
 *  2. `auditarArbol(raiz)` — recorre el árbol y aplica la MISMA regla a cada invocación, venga de
 *     donde venga.
 *
 * Lecciones cableadas en el diseño, todas demostradas por revisores adversariales:
 *
 *  · **Los flags repetidos son un bypass.** firebase usa commander, que se queda con la ÚLTIMA
 *    ocurrencia; un validador que mire la primera aprueba `--project vpw-staging
 *    --project vpw-prod-dd6ff` y despliega a producción. Acá un flag repetido es un ERROR.
 *
 *  · **El alias no es el destino.** firebase re-mapea `--project` contra `.firebaserc` DESPUÉS de
 *    parsear. Validar el literal aprueba `--project vpw-staging` aunque ese alias apunte a
 *    producción. Se valida el destino EFECTIVO, y `.firebaserc` es parte de lo auditado.
 *
 *  · **`--config` decide qué `.firebaserc` manda.** firebase toma el projectRoot del directorio del
 *    config; uno ajeno trae su propio mapa de alias. Solo se aceptan los configs del repo.
 *
 *  · **Enumerar formas peligrosas es perder.** El verificador no busca patrones malos: identifica
 *    TODA invocación de deploy y exige que cada una pase la validación completa.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/** Proyectos que una ruta AUTOMATIZADA puede tocar. Producción NO está y no debe estarlo. */
export const PROYECTOS_PERMITIDOS = Object.freeze(['vpw-dev', 'vpw-staging']);

/** Proyecto productivo real. Solo se despliega a mano, con el runbook de docs/HANDOFF.md §5. */
export const PROYECTO_PRODUCCION = 'vpw-prod-dd6ff';

/** Alias de `.firebaserc` que resuelve a producción. */
export const ALIAS_PRODUCCION = 'production';

/** Config alterno obligatorio para desplegar Functions (artefacto autónomo, fix de `workspace:*`). */
export const CONFIG_FUNCTIONS = 'firebase.functions.json';

/** Configs de firebase que este repo reconoce. Cualquier otro cambia el projectRoot. */
export const CONFIGS_PERMITIDOS = Object.freeze(['firebase.json', CONFIG_FUNCTIONS]);

/** Ruta canónica del helper. La exención de `--only` vale solo para ÉL, no para su nombre. */
const RE_HELPER = /(^|[\\/])apps[\\/]functions[\\/]scripts[\\/]firebase-deploy\.mjs$/;

const RE_PROYECTO = /^[a-z][a-z0-9-]{3,60}$/;

/** Selector de función: `nombre`, `codebase:nombre` (admite guiones) y `grupo.subfuncion`. */
const RE_FUNCION = /^[A-Za-z][A-Za-z0-9_-]*(?:[.:][A-Za-z][A-Za-z0-9_-]*)*$/;

/** Superficies de deploy que NO son Functions. */
const RE_SUPERFICIE = /^(firestore|firestore:rules|firestore:indexes|storage|hosting|remoteconfig|extensions)(:[A-Za-z0-9_-]+)?$/;

/** Metacaracteres de shell: en un argumento real (sin tokenizar) nada legítimo los usa. */
const RE_PELIGROSO = /[;&|`$(){}<>\n\r"'\\]/;

/** Marcador con el que se reemplaza cualquier valor que venga de una variable o expresión. */
export const INTERPOLADO = '__VALOR_INTERPOLADO__';

// ---------------------------------------------------------------------------
// 1) Validación PURA de una invocación
// ---------------------------------------------------------------------------

/** Normaliza `--flag=valor`, `-P valor` y `-Pvalor` a pares [flag, valor]. */
function pares(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith('--') && a.includes('=')) {
      const j = a.indexOf('=');
      out.push([a.slice(0, j), a.slice(j + 1)]);
      continue;
    }
    if (a === '-P') { out.push(['--project', argv[i + 1] ?? '']); i++; continue; }
    if (a.startsWith('-P') && a.length > 2) { out.push(['--project', a.slice(2)]); continue; }
    if (a === '-f') { out.push(['--force', '']); continue; }
    if (a.startsWith('--')) {
      const sig = argv[i + 1];
      if (sig !== undefined && !String(sig).startsWith('-')) { out.push([a, String(sig)]); i++; continue; }
      out.push([a, '']);
      continue;
    }
    out.push([a, '']);
  }
  return out;
}

const valoresDe = (ps, flag) => ps.filter(([f]) => f === flag).map(([, v]) => v);

/** Alias → project-id de `.firebaserc`. Es lo que firebase usa para resolver `--project`. */
export function aliasDeFirebaserc(raiz) {
  for (const rel of ['.firebaserc', '10-backend/.firebaserc']) {
    try {
      const j = JSON.parse(readFileSync(join(raiz, rel), 'utf8'));
      if (j && typeof j.projects === 'object' && j.projects) return j.projects;
    } catch { /* probar el siguiente */ }
  }
  return {};
}

/** Resuelve un `--project` como lo haría firebase: alias primero, si no el literal. */
const resolverProyecto = (valor, aliases) =>
  aliases && Object.prototype.hasOwnProperty.call(aliases, valor) ? String(aliases[valor]) : valor;

/**
 * ¿Es segura esta invocación de `firebase deploy`?
 * Devuelve `{ ok, errores, plan }`. `plan` describe lo que se ejecutaría.
 */
export function validarArgsDeploy(argv, { aliases = null } = {}) {
  const errores = [];
  const lista = (argv ?? []).map(String);
  const ps = pares(lista);
  const plan = { proyecto: null, config: null, superficies: [], funciones: [], soloFunciones: false };

  for (const a of lista) {
    if (RE_PELIGROSO.test(a)) {
      errores.push(`Argumento con metacaracteres de shell (posible inyección): ${JSON.stringify(a)}`);
    }
  }

  // --- Flags REPETIDOS: firebase se queda con el último; validar el primero es un bypass ---
  const conteo = new Map();
  for (const [f] of ps) if (f.startsWith('-')) conteo.set(f, (conteo.get(f) ?? 0) + 1);
  for (const [f, n] of conteo) {
    if (n > 1) {
      errores.push(
        `Flag repetido: \`${f}\` aparece ${n} veces. firebase se queda con la ÚLTIMA ocurrencia, ` +
          'así que un segundo valor puede cambiar el destino sin que se note. Pasá uno solo.',
      );
    }
  }

  if (conteo.has('--force')) {
    errores.push('`--force` está prohibido: oculta borrados y recreaciones de funciones.');
  }

  // --- Proyecto EXPLÍCITO, resuelto y permitido (se validan TODAS las ocurrencias) ---
  const proyectos = valoresDe(ps, '--project');
  if (!proyectos.length || proyectos.every((p) => p === '')) {
    errores.push(
      'Falta `--project` explícito. Sin él, firebase cae al `default` de .firebaserc (hoy `vpw-dev`) ' +
        'y el destino queda a merced de `firebase use` o de variables de entorno.',
    );
  }
  for (const proyecto of proyectos) {
    if (proyecto === '') continue;
    const efectivo = resolverProyecto(proyecto, aliases);
    const comoSeLlama = efectivo === proyecto ? proyecto : `${proyecto} → ${efectivo}`;
    if (proyecto === INTERPOLADO) {
      errores.push(
        'El destino de `--project` viene de una variable o expresión: no se puede demostrar ' +
          'estáticamente que jamás apunte a producción. Fijalo a un literal permitido.',
      );
    } else if (efectivo === PROYECTO_PRODUCCION || proyecto === PROYECTO_PRODUCCION || proyecto === ALIAS_PRODUCCION) {
      errores.push(
        `Destino de PRODUCCIÓN bloqueado (${comoSeLlama}). Producción se despliega únicamente a mano, ` +
          'con selector mínimo auditado y sin `--force`: ver docs/HANDOFF.md §5.',
      );
    } else if (!RE_PROYECTO.test(proyecto)) {
      errores.push(`Valor de \`--project\` inválido: ${JSON.stringify(proyecto)}.`);
    } else if (!PROYECTOS_PERMITIDOS.includes(efectivo)) {
      errores.push(
        `Proyecto no permitido para una ruta automatizada: ${comoSeLlama}. ` +
          `Permitidos: ${PROYECTOS_PERMITIDOS.join(', ')}.`,
      );
    } else {
      plan.proyecto = efectivo;
    }
  }

  // --- --only EXPLÍCITO y no vacío ---
  const onlys = valoresDe(ps, '--only');
  const only = onlys.length ? onlys.join(',') : undefined;
  if (only === undefined || only.trim() === '') {
    errores.push('Falta `--only` con superficies explícitas: un deploy sin `--only` despliega TODO.');
    return { ok: false, errores, plan };
  }

  const objetivos = only.split(',').map((t) => t.trim()).filter(Boolean);
  if (!objetivos.length) {
    errores.push('`--only` quedó vacío después de normalizar.');
    return { ok: false, errores, plan };
  }

  const deFunciones = objetivos.filter((t) => t === 'functions' || t.startsWith('functions:'));
  const otras = objetivos.filter((t) => !deFunciones.includes(t));

  if (deFunciones.includes('functions')) {
    errores.push(
      '`--only functions` genérico está prohibido: despliega TODOS los exports, incluidos los que ' +
        'nunca deben existir en producción (p. ej. `devRunMetaCatalogOutbox`). Usá ' +
        '`functions:<nombre>,functions:<nombre>` con el selector exacto del grafo del cambio.',
    );
  }

  for (const t of deFunciones) {
    if (t === 'functions') continue;
    const nombre = t.slice('functions:'.length);
    if (!nombre) errores.push(`Selector de función vacío en \`--only\`: ${JSON.stringify(t)}.`);
    else if (!RE_FUNCION.test(nombre)) errores.push(`Nombre de función inválido en el selector: ${JSON.stringify(nombre)}.`);
    else plan.funciones.push(nombre);
  }

  for (const t of otras) {
    if (!RE_SUPERFICIE.test(t)) errores.push(`Superficie de deploy desconocida en \`--only\`: ${JSON.stringify(t)}.`);
    else plan.superficies.push(t);
  }

  const configs = valoresDe(ps, '--config');
  const config = configs.length ? configs[configs.length - 1] : undefined;
  plan.config = config ?? null;
  plan.soloFunciones = deFunciones.length > 0 && otras.length === 0;

  // `--config` no es cosmético: firebase toma el projectRoot del directorio del config y lee ESE
  // `.firebaserc`. Uno ajeno trae su propio mapa de alias y puede redirigir un destino "validado".
  if (config !== undefined && !CONFIGS_PERMITIDOS.includes(config)) {
    errores.push(
      `Config no reconocido: ${JSON.stringify(config)}. firebase resuelve los alias de proyecto ` +
        'contra el `.firebaserc` del directorio del config, así que uno ajeno puede cambiar el ' +
        `destino real. Permitidos: ${CONFIGS_PERMITIDOS.join(', ')}.`,
    );
  }

  if (deFunciones.length && otras.length) {
    errores.push(
      'No se pueden mezclar Functions con otras superficies en la misma invocación: Functions ' +
        `necesita \`--config ${CONFIG_FUNCTIONS}\` (artefacto autónomo) y ese config no declara ` +
        'firestore/storage/hosting. Separá los comandos.',
    );
  }

  if (deFunciones.length) {
    if (!config) errores.push(`Falta \`--config ${CONFIG_FUNCTIONS}\`: es el único config que arma el artefacto autónomo de Functions.`);
    else if (config !== CONFIG_FUNCTIONS) errores.push(`Config incorrecto para Functions: ${JSON.stringify(config)}. Debe ser \`${CONFIG_FUNCTIONS}\`.`);
  } else if (config === CONFIG_FUNCTIONS) {
    errores.push(`\`--config ${CONFIG_FUNCTIONS}\` no declara firestore/storage/hosting: no sirve para estas superficies.`);
  }

  return { ok: errores.length === 0, errores, plan };
}

// ---------------------------------------------------------------------------
// 2) Normalización de texto
// ---------------------------------------------------------------------------

/** Quita comentarios de YAML: la documentación del procedimiento manual no es una ruta ejecutable. */
export function sinComentarios(yaml) {
  return String(yaml)
    .split(/\r?\n/)
    .map((l) => (/^\s*#/.test(l) ? '' : l.replace(/\s+#.*$/, '')))
    .join('\n');
}

/**
 * Quita los cuerpos de heredoc: son texto, no comandos. Sin esto, un script que DOCUMENTA el
 * runbook manual dentro de un `cat <<EOF` rompe el build por mencionar los comandos prohibidos.
 */
export function sinHeredocs(texto) {
  return String(texto).replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, '<<HEREDOC');
}

/** Quita comentarios de JS/MJS (línea y bloque) y de shell. */
export function sinComentariosCodigo(texto) {
  return String(texto)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1').replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

/** Reemplaza expresiones y variables por un marcador: un destino no literal no es verificable. */
export function enmascararInterpolacion(cmd) {
  return String(cmd)
    .replace(/\$\{\{[^}]*\}\}/g, INTERPOLADO)
    .replace(/\$\{[^}]*\}/g, INTERPOLADO)
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, INTERPOLADO)
    .replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, INTERPOLADO);
}

const unirContinuaciones = (t) => String(t).replace(/\\\r?\n[ \t]*/g, ' ');

/** Corta un texto en segmentos de comando (saltos, `;`, `&&`, `||`, pipes). */
export function segmentosDeComando(texto) {
  return unirContinuaciones(texto)
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokeniza respetando comillas, SIN truncar el resto del comando. */
export function tokenizar(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(seg))) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Extrae los argumentos de una invocación de deploy en un segmento, o `null` si no lo es. Cubre:
 *   · `<algo-que-dice-firebase> deploy …`  (firebase, pnpm exec firebase, npx firebase-tools, …)
 *   · `deploy …` con binario implícito     (`args:` de una acción de terceros)
 *   · el helper del repo, por su ruta CANÓNICA (no por su nombre de archivo)
 */
export function argumentosDeDeploy(seg, binImplicito = false) {
  const toks = tokenizar(enmascararInterpolacion(seg));
  const iHelper = toks.findIndex((t) => RE_HELPER.test(t));
  if (iHelper >= 0) return { args: toks.slice(iHelper + 1), viaHelper: true };
  // Un archivo que se LLAMA como el helper pero vive en otro lado no hereda su exención: sería un
  // camino de deploy paralelo, sin las garantías del canónico.
  const iImpostor = toks.findIndex((t) => /firebase-deploy\.mjs$/.test(t));
  if (iImpostor >= 0) return { args: toks.slice(iImpostor + 1), viaHelper: false, impostor: toks[iImpostor] };
  const i = toks.findIndex((t) => t === 'deploy');
  if (i < 0) return null;
  const hayBinFirebase = binImplicito || toks.slice(0, i).some((t) => /firebase/i.test(t));
  return hayBinFirebase ? { args: toks.slice(i + 1), viaHelper: false } : null;
}

const hallazgo = (severidad, archivo, titulo, detalle) => ({ severidad, archivo, titulo, detalle });

// ---------------------------------------------------------------------------
// 3) Auditoría por tipo de archivo
// ---------------------------------------------------------------------------

/** Audita TODAS las invocaciones de deploy de un texto contra la validación completa. */
export function auditarComandos(archivo, texto, { binImplicito = false, aliases = null } = {}) {
  const out = [];
  for (const seg of segmentosDeComando(texto)) {
    const inv = argumentosDeDeploy(seg, binImplicito);
    if (inv === null) continue;
    if (enmascararInterpolacion(seg) !== seg) {
      out.push(hallazgo('ALTO', archivo, 'Comando de deploy con valores no verificables estáticamente',
        `El destino o los argumentos vienen de una variable o expresión: ${seg.slice(0, 140)}`));
    }
    if (inv.impostor) {
      out.push(hallazgo('ALTO', archivo, 'Camino de deploy paralelo al helper canónico',
        `\`${inv.impostor}\` se llama como el helper del repo pero no es \`apps/functions/scripts/firebase-deploy.mjs\`: ` +
          'no hereda sus garantías y crea una segunda ruta de deploy.'));
    }
    for (const e of validarArgsDeploy(inv.args, { aliases }).errores) {
      // Una invocación DEL HELPER puede legítimamente no traer `--only` NI `--project`: los aporta
      // quien despliega y el propio helper falla cerrado si faltan — nunca llega a invocar firebase,
      // así que el `default` de `.firebaserc` jamás entra en juego.
      //
      // Que un script NO traiga `--project` es, de hecho, lo que se quiere: `deploy:rules` lo tenía
      // hardcodeado a `vpw-staging`, y un operador que lo corriera pensando en producción se
      // llevaba EXIT 0 con producción intacta. Un script que elige el entorno en silencio es más
      // peligroso que uno que obliga a declararlo. Ojo: la exención vale SOLO para el helper
      // canónico; una invocación directa de `firebase deploy` sigue exigiendo ambos.
      if (inv.viaHelper && /Falta `--only`|Falta `--project`/.test(e)) continue;
      out.push(hallazgo(/PRODUCCIÓN/.test(e) ? 'CRITICO' : 'ALTO', archivo, e, `Comando: ${seg.slice(0, 160)}`));
    }
  }
  return out;
}

/** Referencia ejecutable a producción, en cualquier forma que cambie el destino. */
function auditarReferenciaProduccion(archivo, textoEjecutable) {
  const re = new RegExp(
    '(?:--project(?:\\s+|=)|-P\\s*|firebase\\s+use\\s+|FIREBASE_PROJECT\\s*[:=]\\s*|' +
      `GCLOUD_PROJECT\\s*[:=]\\s*|GOOGLE_CLOUD_PROJECT\\s*[:=]\\s*)(?:${PROYECTO_PRODUCCION}|${ALIAS_PRODUCCION})\\b`,
  );
  return re.test(textoEjecutable)
    ? [hallazgo('CRITICO', archivo, 'Referencia ejecutable al proyecto productivo',
        `Aparece una referencia ejecutable a ${PROYECTO_PRODUCCION} o a su alias \`${ALIAS_PRODUCCION}\`.`)]
    : [];
}

/**
 * Bloques `run:` y `args:` de un YAML, resueltos. Cubre el escalar literal (`|`, una línea por
 * comando) y el plegado (`>`, líneas unidas con espacios) — un `>` sin resolver escondía un
 * `--force` en la línea siguiente.
 */
export function bloquesEjecutables(texto) {
  const lineas = String(texto).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lineas.length; i++) {
    const m = /^(\s*(?:-\s+)?)(run|args):\s*(\|[-+]?|>[-+]?)?\s*(.*)$/.exec(lineas[i]);
    if (!m) continue;
    const sangria = m[1].length;
    const plegado = (m[3] ?? '').startsWith('>');
    const cuerpo = [m[4] ?? ''];
    for (let j = i + 1; j < lineas.length; j++) {
      const l = lineas[j];
      if (l.trim() === '') { cuerpo.push(''); continue; }
      const s = l.length - l.trimStart().length;
      if (s <= sangria) break;
      cuerpo.push(l);
    }
    out.push({ clave: m[2], texto: plegado ? cuerpo.join(' ') : cuerpo.join('\n') });
  }
  return out;
}

/**
 * Pasos que despliegan mediante una ACCIÓN, sin `run:` ni `args:`. La acción oficial de Hosting
 * recibe el destino como parámetro (`projectId:`): un verificador que solo mire comandos no ve un
 * deploy a producción que igual ocurre.
 */
export function auditarUsesConWith(archivo, texto) {
  const out = [];
  const t = String(texto);
  const lineas = t.split(/\r?\n/);
  const re = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm;
  let m;
  while ((m = re.exec(t)) !== null) {
    const accion = m[1];
    if (!/firebase/i.test(accion)) continue;
    const idx = t.slice(0, m.index).split(/\r?\n/).length - 1;
    const bloque = lineas.slice(idx, idx + 25).join('\n');
    const pid = /^\s*projectId:\s*([^\s#]+)/m.exec(bloque)?.[1];
    if (pid && (pid === PROYECTO_PRODUCCION || pid === ALIAS_PRODUCCION)) {
      out.push(hallazgo('CRITICO', archivo, `La accion \`${accion}\` despliega al proyecto productivo`,
        `Recibe \`projectId: ${pid}\`. Produccion no se despliega desde CI.`));
    } else if (!pid) {
      out.push(hallazgo('ALTO', archivo, `La accion \`${accion}\` despliega sin destino explicito`,
        'Sin `projectId` el destino sale del `.firebaserc` (default `vpw-dev`) o del entorno.'));
    } else if (!PROYECTOS_PERMITIDOS.includes(pid)) {
      out.push(hallazgo('ALTO', archivo, `La accion \`${accion}\` apunta a un proyecto no permitido: ${pid}`,
        `Permitidos desde una ruta automatizada: ${PROYECTOS_PERMITIDOS.join(', ')}.`));
    }
  }
  return out;
}

/** Revisa un YAML (workflow de Actions, composite action, cloudbuild, compose…). */
export function auditarWorkflow(archivo, texto, { aliases = null } = {}) {
  const out = [];
  const t = sinComentarios(texto);

  if (/^\s*-\s*production\s*$/m.test(t)) {
    out.push(hallazgo('CRITICO', archivo, 'El workflow ofrece `production` como destino',
      `Una corrida puede elegir producción; \`--project production\` resuelve en .firebaserc al proyecto real ${PROYECTO_PRODUCCION}.`));
  }
  out.push(...auditarReferenciaProduccion(archivo, t));
  out.push(...auditarUsesConWith(archivo, t));

  for (const b of bloquesEjecutables(t)) {
    if (b.clave === 'run' && /\$\{\{/.test(b.texto)) {
      out.push(hallazgo('ALTO', archivo, 'Expresión `${{ }}` interpolada dentro de un `run:`',
        `El comando deja de ser analizable estáticamente y el valor llega al shell sin pasar por \`env:\`. Fragmento: ${b.texto.replace(/\s+/g, ' ').slice(0, 120)}`));
    }
    out.push(...auditarComandos(archivo, b.texto, { binImplicito: b.clave === 'args', aliases }));
  }
  return out;
}

/** Revisa los `scripts` de un package.json. */
export function auditarPackageJson(archivo, texto, { aliases = null } = {}) {
  let json;
  try { json = JSON.parse(String(texto)); } catch { return [hallazgo('ALTO', archivo, 'package.json ilegible', 'No se pudo parsear.')]; }
  const out = [];
  for (const [nombre, cmd] of Object.entries(json.scripts ?? {})) {
    const hs = [...auditarComandos(archivo, String(cmd), { aliases }), ...auditarReferenciaProduccion(archivo, String(cmd))];
    for (const h of hs) out.push({ ...h, titulo: `script \`${nombre}\`: ${h.titulo}` });
  }
  return out;
}

/**
 * Revisa un `firebase*.json`: sus hooks `predeploy`/`postdeploy` son comandos arbitrarios que
 * corren dentro del deploy, con las credenciales ya presentes. Es una ruta ejecutable más.
 */
export function auditarFirebaseJson(archivo, texto, { aliases = null } = {}) {
  let json;
  try { json = JSON.parse(String(texto)); } catch { return []; }
  const out = [];
  const visitar = (nodo, ruta) => {
    if (Array.isArray(nodo)) { nodo.forEach((n, i) => visitar(n, `${ruta}[${i}]`)); return; }
    if (nodo && typeof nodo === 'object') { for (const [k, v] of Object.entries(nodo)) visitar(v, ruta ? `${ruta}.${k}` : k); return; }
    if (typeof nodo !== 'string' || !/predeploy|postdeploy/.test(ruta)) return;
    for (const h of [...auditarComandos(archivo, nodo, { aliases }), ...auditarReferenciaProduccion(archivo, nodo)]) {
      out.push({ ...h, titulo: `${ruta}: ${h.titulo}` });
    }
  };
  visitar(json, '');
  return out;
}

/** Un `.firebaserc` cuyo alias apunte a producción hace que un `--project` "permitido" mienta. */
export function auditarFirebaserc(archivo, texto) {
  let json;
  try { json = JSON.parse(String(texto)); } catch { return [hallazgo('ALTO', archivo, '.firebaserc ilegible', 'No se pudo parsear.')]; }
  const out = [];
  for (const [alias, pid] of Object.entries(json.projects ?? {})) {
    if (String(pid) !== PROYECTO_PRODUCCION) continue;
    if (alias === ALIAS_PRODUCCION) continue; // el alias documentado del procedimiento manual
    out.push(hallazgo('CRITICO', archivo, `El alias \`${alias}\` resuelve al proyecto productivo`,
      `firebase re-mapea \`--project ${alias}\` a ${PROYECTO_PRODUCCION} DESPUÉS de parsear, así que ` +
        'cualquier ruta que use ese alias despliega a producción aunque el literal parezca inocuo.'));
  }
  if (json.projects && Object.prototype.hasOwnProperty.call(json.projects, 'default')
      && String(json.projects.default) === PROYECTO_PRODUCCION) {
    out.push(hallazgo('CRITICO', archivo, 'El proyecto `default` es producción',
      'Cualquier comando sin `--project` explícito iría a producción.'));
  }
  return out;
}

/**
 * Revisa un script ejecutable. Dos cuidados:
 *  · En shell el texto ES el comando (se quitan antes comentarios y cuerpos de heredoc). En JS no:
 *    ahí un comando solo existe dentro de una cadena que se le pasa a un ejecutor — escanear el
 *    texto crudo de un `.mjs` marcaría como invocación cualquier `console.error('… deploy …')`.
 *  · NO se aplica la búsqueda genérica de "referencia a producción" en JS: el id del proyecto
 *    aparece legítimamente en constantes y mensajes. Lo que importa es que no EJECUTE un deploy.
 */
export function auditarScript(archivo, texto, { aliases = null } = {}) {
  const esShell = /\.(sh|bash|ps1|cmd|bat)$/i.test(archivo) || /^#!.*\b(sh|bash|zsh)\b/.test(String(texto));
  const t = esShell ? sinComentariosCodigo(sinHeredocs(texto)) : sinComentariosCodigo(texto);
  const out = esShell ? [...auditarComandos(archivo, t, { aliases })] : [];
  for (const lit of cadenasEjecutadas(t)) out.push(...auditarComandos(archivo, lit, { aliases }));
  const reUse = new RegExp(`firebase\\s+use\\s+(?:${PROYECTO_PRODUCCION}|${ALIAS_PRODUCCION})\\b`);
  if (reUse.test(t)) {
    out.push(hallazgo('CRITICO', archivo, 'El script cambia el proyecto por defecto a producción',
      'Un `firebase use` a producción hace que cualquier comando posterior sin `--project` apunte allí.'));
  }
  return out;
}

/**
 * Cadenas que se pasan a un ejecutor de comandos. Es la diferencia entre un comando escondido
 * entre comillas y un texto que solo se imprime: lo primero despliega, lo segundo explica.
 * Cubre la forma de cadena y la de ARRAY (`spawnSync('firebase', ['deploy', …])`).
 */
export function cadenasEjecutadas(texto) {
  const out = [];
  const t = String(texto);
  const EJECUTORES = '(?:execSync|execFileSync|execFile|spawnSync|spawn|execa(?:Sync|Command)?|exec)';

  // Forma de cadena: exec('firebase deploy …')
  const reCadena = new RegExp(`\\b${EJECUTORES}\\s*\\(\\s*(?:'([^'\\n]*)'|"([^"\\n]*)"|\`([^\`]*)\`)`, 'g');
  let m;
  while ((m = reCadena.exec(t)) !== null) {
    const v = m[1] ?? m[2] ?? m[3];
    if (v) out.push(v);
  }

  // Forma de array: spawnSync('firebase', ['deploy', '--project', 'x'])  → se reconstruye el comando.
  const reArray = new RegExp(`\\b${EJECUTORES}\\s*\\(\\s*(?:'([^'\\n]*)'|"([^"\\n]*)"|([A-Za-z_$][\\w$.]*))\\s*,\\s*\\[([^\\]]*)\\]`, 'g');
  while ((m = reArray.exec(t)) !== null) {
    const bin = m[1] ?? m[2] ?? m[3] ?? '';
    const partes = m[4].split(',').map((s) => s.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean);
    out.push(`${bin} ${partes.join(' ')}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4) Recorrido del árbol
// ---------------------------------------------------------------------------

const IGNORADOS = new Set(['node_modules', '.git', '_archive', 'dist', 'lib', '.next', '.deploy', 'coverage', '.turbo']);

/** Archivos sin extensión que igual son rutas ejecutables conocidas. */
const NOMBRES_EJECUTABLES = new Set(['Dockerfile', 'Makefile', 'Procfile']);

/**
 * Recorre el árbol y devuelve las rutas a auditar, por tipo. Se descubre por recorrido, NO por
 * lista fija: un archivo peligroso puede aparecer en cualquier lado, y un verificador que hardcodea
 * rutas es ciego justamente a lo que nadie esperaba.
 */
export function descubrirArchivos(raiz) {
  const workflows = [], packages = [], firebaseJson = [], firebaserc = [], scripts = [];
  const rec = (dir, rel) => {
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORADOS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        rec(join(dir, e.name), r);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name === 'package.json') packages.push(r);
      else if (e.name === '.firebaserc') firebaserc.push(r);
      else if (/^firebase(\.[A-Za-z0-9_-]+)?\.json$/.test(e.name)) firebaseJson.push(r);
      else if (/\.ya?ml$/i.test(e.name)) workflows.push(r);
      else if (/\.(mjs|cjs|js|sh|bash|ps1|cmd|bat)$/i.test(e.name)) scripts.push(r);
      else if (NOMBRES_EJECUTABLES.has(e.name) || !e.name.includes('.')) scripts.push(r);
    }
  };
  rec(raiz, '');
  return { workflows, packages, firebaseJson, firebaserc, scripts };
}

/**
 * Auditoría completa del árbol.
 *
 * Un workflow es ACTIVO solo si está en `<raiz>/.github/workflows/`. Pero uno LATENTE (anidado) es
 * una bomba con temporizador —si ese subdirectorio se convierte en repo propio o submódulo, se
 * activa tal cual está—, así que se audita igual y su sola existencia ya es un hallazgo.
 */
export function auditarArbol(raiz) {
  const out = [];
  const aliases = aliasDeFirebaserc(raiz);
  const { workflows, packages, firebaseJson, firebaserc, scripts } = descubrirArchivos(raiz);

  for (const rel of workflows) {
    const texto = readFileSync(join(raiz, rel), 'utf8');
    const esDeActions = /(^|\/)\.github\/workflows\//.test(`/${rel}`);
    const activo = /^\.github\/workflows\/[^/]+$/.test(rel);
    const hs = auditarWorkflow(rel, texto, { aliases });
    if (esDeActions && !activo && (hs.length || /\bdeploy\b/.test(sinComentarios(texto)))) {
      out.push(hallazgo('CRITICO', rel, 'Workflow de deploy LATENTE fuera de `.github/workflows/` de la raíz',
        'GitHub Actions no lo ejecuta hoy porque la raíz del repo es otra, pero está versionado: si ese ' +
          'subdirectorio pasa a ser repo propio o submódulo, se activa exactamente como está.'));
    }
    out.push(...hs);
  }
  for (const rel of packages) out.push(...auditarPackageJson(rel, readFileSync(join(raiz, rel), 'utf8'), { aliases }));
  for (const rel of firebaseJson) out.push(...auditarFirebaseJson(rel, readFileSync(join(raiz, rel), 'utf8'), { aliases }));
  for (const rel of firebaserc) out.push(...auditarFirebaserc(rel, readFileSync(join(raiz, rel), 'utf8')));
  for (const rel of scripts) {
    let texto;
    try { texto = readFileSync(join(raiz, rel), 'utf8'); } catch { continue; }
    out.push(...auditarScript(rel, texto, { aliases }));
  }
  return out;
}

/**
 * Raíz del repo, donde vive `.github/`. Se ancla subiendo desde la ubicación de ESTE módulo hasta
 * encontrar `.firebaserc` y tomando su padre — contar `../..` hacía que la función devolviera cosas
 * distintas según quién la llamara.
 */
export function raizRepo() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      readFileSync(join(dir, '.firebaserc'), 'utf8');
      return join(dir, '..');
    } catch { /* seguir subiendo */ }
    const padre = join(dir, '..');
    if (padre === dir) break;
    dir = padre;
  }
  throw new Error('No pude anclar la raíz del repo: no encontré `.firebaserc` subiendo desde deploy-guard.mjs');
}

/** Compatibilidad: los segmentos de un texto que SON invocaciones de deploy. */
export const extraerComandosDeploy = (texto) =>
  segmentosDeComando(texto).filter((s) => argumentosDeDeploy(s) !== null);

// ---------------------------------------------------------------------------
// 5) CLI — `node deploy-guard.mjs --audit`
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes('--audit')) {
    console.error('Uso: node deploy-guard.mjs --audit');
    process.exit(2);
  }
  const hs = auditarArbol(raizRepo());
  if (!hs.length) {
    console.log('[deploy-guard] OK — ninguna ruta ejecutable de deploy insegura.');
    process.exit(0);
  }
  console.error(`[deploy-guard] ${hs.length} hallazgo(s) — las rutas de deploy NO son fail-closed:\n`);
  const por = new Map();
  for (const h of hs) { if (!por.has(h.archivo)) por.set(h.archivo, []); por.get(h.archivo).push(h); }
  for (const [archivo, l] of por) {
    console.error(`  ${archivo}`);
    for (const h of l) console.error(`    [${h.severidad}] ${h.titulo}`);
  }
  console.error('\n  Regla: proyecto explícito (resuelto contra .firebaserc) y config del repo, sin flags');
  console.error('  repetidos, sin --force, sin `--only functions` genérico, y producción jamás automatizada.');
  process.exit(1);
}
