/**
 * release-audit.mjs — Superficie EXACTA del release, calculada del grafo COMPILADO. NO DESPLIEGA.
 * ================================================================================================
 * Este script no toca producción salvo para LEERLA, y no ejecuta ningún paso del release. Su única
 * salida es un informe saneado y un exit code real.
 *
 * QUÉ RESUELVE, Y POR QUÉ NO ALCANZABA LISTAR A MANO
 * --------------------------------------------------
 * `docs/HANDOFF.md` §5 exige desplegar Functions con un selector explícito derivado del «cierre
 * transitivo de imports desde cada export de `index.ts` hasta los módulos cuyo COMPORTAMIENTO
 * cambió en el diff». Ese cálculo se venía haciendo a ojo. Dos cosas lo hacen inseguro a mano:
 *
 *  1. `index.ts` re-exporta en bloques MULTILÍNEA. Un regex por línea pierde todos los nombres que
 *     no comparten renglón con su `from` — hoy son 21, y cada nombre perdido es una función que
 *     queda sin actualizar (o, peor, una que se crea sin querer). Por eso acá los exports se
 *     calculan por DOS vías independientes —el `.ts` fuente y el `.js` COMPILADO— y se exige
 *     coincidencia EXACTA: si difieren, el grafo está mal y el informe lo dice en vez de seguir.
 *  2. El arranque de `index.ts` (los `wire*`/`set*` de ADR-0015 y ADR-0016) importa módulos que
 *     entran en el grafo de TODAS las funciones. Un cambio ahí no se "ve" leyendo el diff por
 *     dominios, pero alcanza a todo lo desplegado.
 *
 * CÓMO SE DECIDE QUE UN MÓDULO "CAMBIÓ"
 * --------------------------------------
 * Se compara el contenido contra el commit BASE (el último desplegado a producción), NORMALIZADO:
 * sin comentarios, sin sentencias de re-export y con espacios colapsados, y con finales de línea
 * unificados (el repo mezcla CRLF y LF; sin esto, todo parecería cambiado). O sea: un archivo cuyo
 * único diff son comentarios NO cuenta como cambio de comportamiento, y un barril al que solo se
 * le agregaron re-exports tampoco — los consumidores que usan los símbolos nuevos igual quedan
 * alcanzados, porque el recorrido del grafo es POR SÍMBOLO.
 *
 * Recorrido por símbolo, y su límite declarado: un `export … from` se sigue SOLO para el símbolo
 * pedido. La consecuencia es deliberada — que un barril evalúe a sus vecinos en tiempo de módulo no
 * se cuenta como alcance semántico. En este repo el patrón de efecto de import está en los
 * `import` DIRECTOS del arranque de `index.ts` (que sí se siguen siempre, para todas las
 * funciones), no en re-exports. Si algún día un módulo re-exportado adquiere efectos de import,
 * esta suposición deja de valer y hay que revisarla acá.
 *
 * EL GATE QUE PUEDE ABORTAR LA AUDITORÍA
 * --------------------------------------
 * ADR-0017 (consecuencias): «la migración del PNID actual a `live` corre ANTES de desplegar el
 * gate. Al revés, el número que vende leería el campo ausente, resolvería `inactive` y se quedaría
 * callado». Esa dependencia de ORDEN no la puede sostener la memoria del operador: acá se verifica
 * leyendo (SOLO lectura) los números que hoy rutean inbound, y si alguno no tiene
 * `automationMode: 'live'` declarado, la auditoría sale BLOQUEADA y NO emite selector de deploy.
 * Se compara el valor CRUDO —igual que la idempotencia de `migrate-whatsapp-automation-mode.mjs`—
 * porque un `'LIVE'` escrito a mano resuelve `inactive` en el gate y dejaría al número mudo.
 *
 * Este script NO corre esa migración. Solo verifica que ya haya corrido.
 *
 * USO:
 *   node scripts/release-audit.mjs --project <projectId>     # lee prod read-only y audita todo
 *   node scripts/release-audit.mjs --sin-red                 # solo grafo y parsing, sin red
 *   node scripts/release-audit.mjs --project <id> --json     # informe saneado en JSON
 *   [--base <ref>]  commit base (por defecto: el último desplegado, ver COMMIT_BASE_DESPLEGADO)
 *
 * EXIT CODES: 0 auditoría completa y sin bloqueos · 1 BLOQUEADO (precondición o incoherencia del
 * grafo) · 2 error de uso.
 *
 * El informe es SANEADO: los teléfonos van enmascarados y nunca se imprimen tokens, mensajes,
 * URLs firmadas ni coordenadas. Este script no los lee.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_FUNCTIONS = resolve(AQUI, '..');
const RAIZ_BACKEND = resolve(RAIZ_FUNCTIONS, '../..');

/**
 * Último commit DESPLEGADO a producción: DEPLOY-AI-PHASE2-SALES-RESERVATION-1 (2026-08-16Z,
 * 10 UPDATE / 0 CREATE). Verificado contra producción el 2026-08-18 leyendo GCF v2 read-only:
 * el `updateTime` máximo de las 118 functions es 2026-08-16T00:35Z con exactamente 10 funciones
 * actualizadas ese día — nada se desplegó después. Es un valor por defecto documentado, no un
 * supuesto: `--base` lo pisa, y el informe siempre imprime cuál se usó. Si se despliega de
 * nuevo, ACTUALIZAR esta constante en el mismo programa de deploy (el valor viejo `30c1687`
 * infló un selector con funciones ya desplegadas — ver BITACORA 2026-08-18).
 */
export const COMMIT_BASE_DESPLEGADO = '6f75601';

/** Un teléfono JAMÁS se imprime entero (misma convención que el motor y la migración). */
export function enmascararPnid(pnid) {
  return `…${String(pnid ?? '').slice(-4)}`;
}

// =================================================================================================
// 1. PARSING — puro, sin disco. Es lo que testea `tests/integration/release-audit.*.test.ts`.
// =================================================================================================

/**
 * Quita comentarios respetando literales. Reconoce `'`, `"`, plantillas y expresiones regulares
 * (una `/` abre regex salvo que el token anterior pueda cerrar una expresión). Sin esto, un
 * `// export { x } from 'y'` comentado entraría al grafo — y en este repo hay bloques enteros de
 * exports comentados al principio de `index.ts`.
 */
export function quitarComentarios(fuente) {
  const s = String(fuente ?? '');
  let out = '';
  let i = 0;
  let anterior = '';
  const puedeCerrarExpresion = (c) => /[A-Za-z0-9_$)\]]/.test(c);
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const cierre = c;
      out += c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          out += s[i] + (s[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += s[i];
        if (s[i] === cierre) {
          i++;
          break;
        }
        i++;
      }
      anterior = cierre;
      continue;
    }
    if (c === '/' && !puedeCerrarExpresion(anterior)) {
      // Literal de expresión regular: se copia entero para no confundir su contenido con código.
      out += c;
      i++;
      let enClase = false;
      while (i < s.length) {
        if (s[i] === '\\') {
          out += s[i] + (s[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (s[i] === '[') enClase = true;
        else if (s[i] === ']') enClase = false;
        else if (s[i] === '/' && !enClase) {
          out += s[i];
          i++;
          break;
        } else if (s[i] === '\n') break;
        out += s[i];
        i++;
      }
      anterior = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) anterior = c;
    i++;
  }
  return out;
}

const RE_LISTA = String.raw`\{([\s\S]*?)\}`;
const RE_DESDE = String.raw`from\s*['"]([^'"]+)['"]`;

/** Separa `a, b as c, type D` en nombres EXPORTADOS (el alias, si lo hay), sin los `type`. */
function nombresDeLista(lista) {
  return String(lista)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^type\s/.test(x))
    .map((x) => {
      const m = /^(.+?)\s+as\s+(.+)$/.exec(x);
      return (m ? m[2] : x).trim();
    })
    .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
}

/** Igual que `nombresDeLista` pero devuelve el nombre ORIGEN (el de la izquierda del `as`). */
function nombresOrigenDeLista(lista) {
  return String(lista)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^type\s/.test(x))
    .map((x) => {
      const m = /^(.+?)\s+as\s+(.+)$/.exec(x);
      return (m ? m[1] : x).trim();
    })
    .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
}

/**
 * Nombres re-exportados por un archivo, MULTILÍNEA. Devuelve `[{ nombre, origen, especificador }]`.
 * `export type { … } from` se ignora: se borra al compilar y no es alcance de runtime.
 */
export function exportsReexportados(fuente) {
  const limpio = quitarComentarios(fuente);
  const re = new RegExp(String.raw`export\s+${RE_LISTA}\s*${RE_DESDE}`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(limpio)) !== null) {
    const previo = limpio.slice(Math.max(0, m.index - 20), m.index + 7);
    if (/export\s+type\s*$/.test(previo.slice(0, previo.length - 0))) continue;
    const alias = nombresDeLista(m[1]);
    const origen = nombresOrigenDeLista(m[1]);
    for (let k = 0; k < alias.length; k++) {
      out.push({ nombre: alias[k], origen: origen[k] ?? alias[k], especificador: m[2] });
    }
  }
  return out;
}

/** `export * from '…'` — devuelve los especificadores. */
export function reexportsEstrella(fuente) {
  const limpio = quitarComentarios(fuente);
  const re = new RegExp(String.raw`export\s*\*\s*(?:as\s+[\w$]+\s*)?${RE_DESDE}`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(limpio)) !== null) out.push(m[1]);
  return out;
}

/**
 * La vía INCORRECTA, conservada a propósito: un regex por LÍNEA. No se usa para decidir nada; el
 * informe la calcula solo para exhibir cuántos nombres se pierden. Si algún día este número da 0,
 * es que `index.ts` dejó de tener bloques multilínea — no que el atajo se volvió seguro.
 */
export function exportsPorLinea(fuente) {
  const out = [];
  for (const linea of quitarComentarios(fuente).split(/\r?\n/)) {
    const m = new RegExp(String.raw`^\s*export\s+${RE_LISTA}\s*${RE_DESDE}`).exec(linea);
    if (m) for (const n of nombresDeLista(m[1])) out.push(n);
  }
  return out;
}

/** Nombres que un archivo define y exporta ÉL MISMO (no re-exporta). */
export function exportsPropios(fuente) {
  const limpio = quitarComentarios(fuente);
  const out = new Set();
  const reDecl = /export\s+(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(const|let|var|function\*?|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = reDecl.exec(limpio)) !== null) out.add(m[2]);
  const reLocal = new RegExp(String.raw`export\s+${RE_LISTA}\s*(?!\s*from)`, 'g');
  while ((m = reLocal.exec(limpio)) !== null) {
    // Descarta los que sí llevan `from` (el lookahead no cubre el salto de línea del bloque).
    const cola = limpio.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (/^\s*from\s*['"]/.test(cola)) continue;
    for (const n of nombresDeLista(m[1])) out.add(n);
  }
  return out;
}

/**
 * Imports de VALOR de un archivo. `import type …` y `import { type X }` quedan afuera: no existen
 * en runtime, y arrastrarlos inflaría el selector con módulos que solo aportan tipos.
 */
export function importsDeValor(fuente) {
  const limpio = quitarComentarios(fuente);
  const out = [];
  const re = new RegExp(String.raw`import\s+(?!type\s)([\s\S]*?)\s*${RE_DESDE}`, 'g');
  let m;
  while ((m = re.exec(limpio)) !== null) {
    const clausula = m[1].trim();
    const especificador = m[2];
    const bloque = /\{([\s\S]*?)\}/.exec(clausula);
    const tieneDefaultOEstrella = /(^|,)\s*(\*\s*as\s+[\w$]+|[A-Za-z_$][\w$]*)\s*(,|$)/.test(
      clausula.replace(/\{[\s\S]*?\}/, ''),
    );
    if (tieneDefaultOEstrella) out.push({ especificador, todo: true, nombres: [] });
    else if (bloque) {
      const nombres = nombresOrigenDeLista(bloque[1]);
      if (nombres.length > 0) out.push({ especificador, todo: false, nombres });
    }
  }
  // `import './x.js'` (solo por efecto): alcance completo.
  const reBare = /import\s*['"]([^'"]+)['"]/g;
  while ((m = reBare.exec(limpio)) !== null) out.push({ especificador: m[1], todo: true, nombres: [] });
  return out;
}

/**
 * Contenido normalizado para decidir si el COMPORTAMIENTO cambió: sin comentarios, sin sentencias
 * de re-export y con espacios colapsados. Los finales de línea se unifican primero — el repo mezcla
 * CRLF y LF y, sin esto, todo archivo tocado por git parecería distinto.
 */
export function normalizarComportamiento(fuente) {
  let s = quitarComentarios(String(fuente ?? '').replace(/\r\n/g, '\n'));
  s = s.replace(new RegExp(String.raw`export\s+${RE_LISTA}\s*${RE_DESDE}\s*;?`, 'g'), '');
  s = s.replace(new RegExp(String.raw`export\s*\*\s*(?:as\s+[\w$]+\s*)?${RE_DESDE}\s*;?`, 'g'), '');
  return s.replace(/\s+/g, ' ').trim();
}

// =================================================================================================
// 2. GRAFO — resolución de especificadores y cierre transitivo POR SÍMBOLO.
// =================================================================================================

/**
 * Resuelve un especificador a una ruta de archivo del proyecto, o `null` si es externo.
 * `@vpw/shared` se resuelve a su FUENTE porque se empaqueta con el artefacto (tarball del
 * workspace): un cambio ahí viaja al deploy igual que uno de `src/`.
 */
export function resolverEspecificador({ desde, especificador, existe, modo }) {
  const ext = modo === 'lib' ? '.js' : '.ts';
  const candidatos = [];
  if (especificador.startsWith('.')) {
    const base = join(dirname(desde), especificador).replace(/\\/g, '/');
    if (base.endsWith('.js')) candidatos.push(base.slice(0, -3) + ext, base);
    else candidatos.push(base + ext, join(base, 'index' + ext).replace(/\\/g, '/'), base);
  } else if (especificador === '@vpw/shared' || especificador.startsWith('@vpw/shared/')) {
    const sub = especificador === '@vpw/shared' ? 'index' : especificador.slice('@vpw/shared/'.length);
    const base = join(RAIZ_BACKEND, 'packages/shared/src', sub).replace(/\\/g, '/');
    candidatos.push(base + '.ts', join(base, 'index.ts').replace(/\\/g, '/'));
  } else {
    return null; // dependencia externa: no se recorre
  }
  for (const c of candidatos) if (existe(c)) return c;
  return null;
}

/** Registro por archivo que consume el recorrido. */
export function analizarArchivo(fuente) {
  return {
    imports: importsDeValor(fuente),
    reexports: exportsReexportados(fuente),
    estrellas: reexportsEstrella(fuente),
    propios: exportsPropios(fuente),
    normalizado: normalizarComportamiento(fuente),
  };
}

/**
 * Cierre transitivo desde `entrada` para UN nombre exportado. Devuelve el conjunto de archivos
 * alcanzados. Los `import` DIRECTOS de la entrada (el arranque de `index.ts`) entran SIEMPRE: se
 * ejecutan en toda función, sea cual sea el export.
 */
export function cierreDeExport({ grafo, entrada, nombre }) {
  const alcanzados = new Set();
  const visitadoTodo = new Set();
  const visitadoSimbolo = new Map();
  const pendientes = [];

  const encolar = (archivo, simbolos) => {
    if (!archivo || !grafo.has(archivo)) return;
    if (simbolos === '*') {
      if (visitadoTodo.has(archivo)) return;
      visitadoTodo.add(archivo);
      pendientes.push({ archivo, simbolos: '*' });
      return;
    }
    const vistos = visitadoSimbolo.get(archivo) ?? new Set();
    const nuevos = simbolos.filter((s) => !vistos.has(s));
    if (nuevos.length === 0) return;
    for (const s of nuevos) vistos.add(s);
    visitadoSimbolo.set(archivo, vistos);
    pendientes.push({ archivo, simbolos: nuevos });
  };

  const seguirImports = (archivo) => {
    for (const imp of grafo.get(archivo).imports) {
      const destino = grafo.get(archivo).resueltos.get(imp.especificador);
      if (!destino) continue;
      encolar(destino, imp.todo ? '*' : imp.nombres);
    }
  };

  const reg0 = grafo.get(entrada);
  if (!reg0) return alcanzados;
  alcanzados.add(entrada);
  seguirImports(entrada); // arranque: vale para TODAS las funciones
  const rx = reg0.reexports.find((r) => r.nombre === nombre);
  if (rx) {
    const destino = reg0.resueltos.get(rx.especificador);
    encolar(destino, [rx.origen]);
  }

  while (pendientes.length > 0) {
    const { archivo, simbolos } = pendientes.pop();
    const reg = grafo.get(archivo);
    if (!reg) continue;
    alcanzados.add(archivo);
    if (simbolos === '*') {
      seguirImports(archivo);
      for (const r of reg.reexports) encolar(reg.resueltos.get(r.especificador), [r.origen]);
      for (const e of reg.estrellas) encolar(reg.resueltos.get(e), '*');
      continue;
    }
    let algunoPropio = false;
    for (const s of simbolos) {
      if (reg.propios.has(s)) {
        algunoPropio = true;
        continue;
      }
      const r = reg.reexports.find((x) => x.nombre === s);
      if (r) {
        encolar(reg.resueltos.get(r.especificador), [r.origen]);
        continue;
      }
      // `export *`: se sigue al que DEFINE el símbolo; si no se puede saber, a todos.
      const definidores = reg.estrellas
        .map((e) => reg.resueltos.get(e))
        .filter((d) => d && grafo.get(d)?.propios.has(s));
      if (definidores.length > 0) for (const d of definidores) encolar(d, [s]);
      else for (const e of reg.estrellas) encolar(reg.resueltos.get(e), [s]);
    }
    if (algunoPropio) seguirImports(archivo);
  }
  return alcanzados;
}

// =================================================================================================
// 3. SUPERFICIE DEL RELEASE
// =================================================================================================

/**
 * Clasifica cada export contra lo desplegado.
 *
 * `ausentesEnProdPorDiseño` son los `dev*` que están exportados pero NO existen en producción:
 * `--only functions` a secas los CREARÍA. Nunca entran al selector, y si alguno se colara el
 * informe sale BLOQUEADO.
 */
export function clasificarSuperficie({ exportados, desplegados, cambiados, cierres }) {
  const setDesplegados = new Set(desplegados);
  const create = [];
  const update = [];
  const sinCambio = [];
  const ausentesEnProdPorDiseno = [];
  for (const nombre of exportados) {
    const cierre = cierres.get(nombre) ?? new Set();
    const tocado = [...cierre].some((f) => cambiados.has(f));
    if (!setDesplegados.has(nombre)) {
      if (/^dev/.test(nombre)) ausentesEnProdPorDiseno.push(nombre);
      else create.push(nombre);
      continue;
    }
    if (tocado) update.push(nombre);
    else sinCambio.push(nombre);
  }
  const del = desplegados.filter((n) => !exportados.includes(n));
  const selector = [...create, ...update].sort();
  // Defensa en profundidad: ningún nombre ausente-por-diseño puede quedar en el selector. Por
  // construcción no puede pasar; se chequea igual porque el día que alguien toque la clasificación,
  // el síntoma sería crear en producción una función que se decidió que no existiera.
  const fugados = selector.filter((n) => ausentesEnProdPorDiseno.includes(n));
  // Partición COMPLETA: cada export cae en exactamente un balde. Si no cierra, el parser perdió o
  // duplicó nombres y ningún número del informe se puede usar.
  const particionCompleta =
    create.length + update.length + sinCambio.length + ausentesEnProdPorDiseno.length === exportados.length;
  return {
    create: create.sort(),
    update: update.sort(),
    sinCambio: sinCambio.sort(),
    delete: del.sort(),
    ausentesEnProdPorDiseno: ausentesEnProdPorDiseno.sort(),
    selector,
    fugados,
    particionCompleta,
  };
}

/**
 * Veredicto del release. Es una función PURA a propósito: la regla de orden de ADR-0017 —«la
 * migración corre ANTES del deploy»— tiene que poder probarse sin red y sin emulador, porque la
 * única forma de verificarla en vivo sería desplegando.
 *
 * BLOQUEADO nunca devuelve selector: un informe bloqueado no puede ofrecer nada copiable.
 */
export function veredictoDeRelease({ precondicion = null, superficie = null, divergencias = [], noResueltos = [] } = {}) {
  const bloqueos = [];
  if (divergencias.length > 0) bloqueos.push('grafo_divergente_src_vs_lib');
  if (noResueltos.length > 0) bloqueos.push('imports_no_resueltos');
  if (precondicion && !precondicion.ok) bloqueos.push(precondicion.motivo ?? 'precondicion_desconocida');
  if (superficie && superficie.fugados.length > 0) bloqueos.push('dev_en_selector');
  if (superficie && !superficie.particionCompleta) bloqueos.push('particion_incompleta');
  const bloqueado = bloqueos.length > 0;
  return {
    veredicto: bloqueado ? 'BLOQUEADO' : superficie ? 'OK' : 'PARCIAL_SIN_RED',
    bloqueos,
    selector: bloqueado || !superficie ? null : superficie.selector.map((n) => `functions:${n}`).join(','),
  };
}

/**
 * ADR-0017 — LA MIGRACIÓN CORRE ANTES QUE EL GATE.
 *
 * `numeros`: `[{ tenantId, phoneNumberId, automationModeCrudo, automationModeIndiceCrudo, status,
 * selected, ruteaInbound }]`, leídos SOLO de lectura. Un número que hoy rutea inbound y no está
 * declarado EXACTAMENTE `live` quedaría mudo apenas se despliegue el gate: eso bloquea el release.
 *
 * Se compara el valor CRUDO a propósito. `'LIVE'`, `'Live'` o `' live'` resuelven `inactive` en el
 * gate (fail-closed), así que aceptarlos acá sería declarar migrado lo que va a quedar callado.
 *
 * EL ÍNDICE TAMBIÉN VOTA, y por eso también se mira. El desempate del §1 es por el estado MÁS
 * RESTRICTIVO entre asset e índice, y `accountUpdate` (§6) degrada en los DOS documentos: tras un
 * `ACCOUNT_OFFBOARDED` y una reconexión, el asset puede decir `live` y el índice seguir diciendo
 * `inactive` — el gate lo lee mudo. Mirar solo el asset certificaba como migrado exactamente ese
 * estado. La AUSENCIA del campo en el índice no vota (igual que en `declaredAutomationMode`): la
 * migración normal es de un solo documento y no puede quedar bloqueada por eso.
 */
export function verificarPrecondicionDeMigracion(numeros) {
  const relevantes = (numeros ?? []).filter((n) => n && n.ruteaInbound);
  /** ¿El índice OPINA? `undefined`/`null` = no tiene el campo; cualquier otra cosa sí opina. */
  const indiceOpina = (v) => v !== undefined && v !== null;
  const pendientes = relevantes
    .filter((n) => n.automationModeCrudo !== 'live' || (indiceOpina(n.automationModeIndiceCrudo) && n.automationModeIndiceCrudo !== 'live'))
    .map((n) => ({
      tenantId: n.tenantId ?? null,
      numero: enmascararPnid(n.phoneNumberId),
      declarado: typeof n.automationModeCrudo === 'string' ? n.automationModeCrudo : null,
      declaradoIndice: typeof n.automationModeIndiceCrudo === 'string' ? n.automationModeIndiceCrudo : null,
      // El motivo del ASSET tiene prioridad: es el documento que manda y el que toca la migración.
      motivo:
        n.automationModeCrudo === undefined || n.automationModeCrudo === null
          ? 'campo_ausente'
          : n.automationModeCrudo !== 'live'
            ? 'modo_no_live'
            : 'indice_no_live',
    }));
  return {
    ok: relevantes.length > 0 && pendientes.length === 0,
    evaluados: relevantes.length,
    pendientes,
    motivo:
      relevantes.length === 0
        ? 'sin_numeros_ruteados'
        : pendientes.length === 0
          ? null
          : 'migracion_pendiente',
  };
}

// =================================================================================================
// 4. E/S — disco, git y lectura READ-ONLY de producción.
// =================================================================================================

function listarArchivos(dir, ext, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.deploy' || e === 'dist') continue;
    const p = join(dir, e).replace(/\\/g, '/');
    if (statSync(p).isDirectory()) listarArchivos(p, ext, acc);
    else if (p.endsWith(ext) && !p.endsWith('.test' + ext) && !p.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

/** Construye el grafo de un modo (`src` con `.ts`, `lib` con `.js`) resolviendo cada import. */
export function construirGrafo({ archivos, leer, modo }) {
  const set = new Set(archivos);
  const existe = (p) => set.has(p);
  const grafo = new Map();
  for (const f of archivos) grafo.set(f, { ...analizarArchivo(leer(f)), resueltos: new Map() });
  const noResueltos = [];
  for (const [f, reg] of grafo) {
    const specs = new Set([
      ...reg.imports.map((i) => i.especificador),
      ...reg.reexports.map((r) => r.especificador),
      ...reg.estrellas,
    ]);
    for (const s of specs) {
      const destino = resolverEspecificador({ desde: f, especificador: s, existe, modo });
      if (destino) reg.resueltos.set(s, destino);
      else if (s.startsWith('.') || s.startsWith('@vpw/')) noResueltos.push({ archivo: f, especificador: s });
    }
  }
  return { grafo, noResueltos };
}

function gitShow(repoRoot, ref, relPath) {
  try {
    // stderr silenciado: un archivo NUEVO hace que `git show` escriba «fatal: …» y eso no es un
    // error del script — es exactamente la señal de «módulo nuevo», que se maneja abajo.
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Módulos cuyo COMPORTAMIENTO cambió respecto del commit base. */
export function modulosCambiados({ archivos, leer, repoRoot, base }) {
  const cambiados = new Set();
  const nuevos = [];
  for (const f of archivos) {
    const rel = relative(repoRoot, f).replace(/\\/g, '/');
    const antes = gitShow(repoRoot, base, rel);
    if (antes === null) {
      cambiados.add(f);
      nuevos.push(rel);
      continue;
    }
    if (normalizarComportamiento(antes) !== normalizarComportamiento(leer(f))) cambiados.add(f);
  }
  return { cambiados, nuevos };
}

/**
 * Lee de PRODUCCIÓN, SOLO LECTURA, los números que rutean inbound y su `automationMode` declarado.
 * Usa el patrón documentado en `docs/HANDOFF.md` §5 (firebase-tools + REST). No escribe nada, no
 * llama a Meta y no imprime el número entero.
 */
async function leerNumerosRuteados(projectId) {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const raizFT = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim() + '/firebase-tools';
  const base = existsSync(`${raizFT}/lib/requireAuth.js`)
    ? raizFT
    : `${process.env.APPDATA ?? ''}/npm/node_modules/firebase-tools`.replace(/\\/g, '/');
  const { requireAuth } = req(`${base}/lib/requireAuth`);
  const { Client } = req(`${base}/lib/apiv2`);
  const auth = req(`${base}/lib/auth`);
  const cuenta = auth.getProjectDefaultAccount();
  await requireAuth({ project: projectId, projectId, ...(cuenta ?? {}) });
  const client = new Client({ urlPrefix: 'https://firestore.googleapis.com', apiVersion: 'v1' });
  const docs = `projects/${projectId}/databases/(default)/documents`;

  const idx = await client.get(`/${docs}/metaExternalIndex`);
  const entradas = idx.body?.documents ?? [];
  const numeros = [];
  for (const d of entradas) {
    const id = String(d.name ?? '').split('/').pop() ?? '';
    if (!id.startsWith('whatsapp_')) continue;
    const pnid = id.slice('whatsapp_'.length);
    const tenantId = d.fields?.tenantId?.stringValue ?? null;
    const idxFields = d.fields ?? null;
    let asset = null;
    if (tenantId) {
      try {
        const r = await client.get(`/${docs}/tenants/${tenantId}/metaAssets/${pnid}`);
        asset = r.body?.fields ?? null;
      } catch {
        asset = null;
      }
    }
    numeros.push({
      tenantId,
      phoneNumberId: pnid,
      ruteaInbound: true,
      status: asset?.status?.stringValue ?? null,
      selected: asset?.selected?.booleanValue ?? null,
      // `undefined` = el campo NO existe; distinto de un valor presente pero inválido.
      automationModeCrudo: asset && 'automationMode' in asset ? (asset.automationMode?.stringValue ?? null) : undefined,
      // El índice también declara permiso desde que `accountUpdate` degrada en los dos documentos
      // (ADR-0017 §6), y el gate desempata por el más restrictivo: hay que verlo para no certificar
      // como migrado un número que va a quedar mudo.
      automationModeIndiceCrudo: idxFields && 'automationMode' in idxFields ? (idxFields.automationMode?.stringValue ?? null) : undefined,
      assetPresente: !!asset,
    });
  }
  return numeros;
}

/** Nombres de Functions desplegadas (lectura). */
async function leerFunctionsDesplegadas(projectId) {
  const salida = execFileSync('firebase', ['functions:list', '--project', projectId, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  const j = JSON.parse(salida);
  const r = j.result ?? j;
  return {
    nombres: r.map((f) => f.id).sort(),
    schedulers: r.filter((f) => f.scheduleTrigger).map((f) => f.id).sort(),
  };
}

// =================================================================================================
// 5. ORQUESTACIÓN
// =================================================================================================

export async function auditarRelease({ base = COMMIT_BASE_DESPLEGADO, projectId = null, leerProd = null } = {}) {
  const leer = (p) => readFileSync(p, 'utf8');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: RAIZ_BACKEND, encoding: 'utf8' }).trim();

  // --- exports por DOS vías independientes -------------------------------------------------
  const srcIndex = join(RAIZ_FUNCTIONS, 'src/index.ts').replace(/\\/g, '/');
  const libIndex = join(RAIZ_FUNCTIONS, 'lib/index.js').replace(/\\/g, '/');
  if (!existsSync(libIndex)) {
    return { veredicto: 'BLOQUEADO', motivo: 'lib_sin_compilar', detalle: 'Falta apps/functions/lib/index.js: corré `pnpm --filter functions build`.' };
  }
  const desdeSrc = exportsReexportados(leer(srcIndex)).map((r) => r.nombre).sort();
  const desdeLib = exportsReexportados(leer(libIndex)).map((r) => r.nombre).sort();
  const soloSrc = desdeSrc.filter((n) => !desdeLib.includes(n));
  const soloLib = desdeLib.filter((n) => !desdeSrc.includes(n));
  const porLinea = exportsPorLinea(leer(srcIndex));
  const perdidosPorLinea = desdeSrc.filter((n) => !porLinea.includes(n));
  if (soloSrc.length > 0 || soloLib.length > 0) {
    return {
      veredicto: 'BLOQUEADO',
      motivo: 'grafo_incoherente',
      detalle: 'Los exports del fuente y del compilado NO coinciden; el grafo no es confiable.',
      soloSrc,
      soloLib,
    };
  }

  // --- grafo compilado + grafo fuente ------------------------------------------------------
  const archivosSrc = [
    ...listarArchivos(join(RAIZ_FUNCTIONS, 'src'), '.ts'),
    ...listarArchivos(join(RAIZ_BACKEND, 'packages/shared/src'), '.ts'),
  ];
  const archivosLib = listarArchivos(join(RAIZ_FUNCTIONS, 'lib'), '.js');
  const { grafo: grafoSrc, noResueltos } = construirGrafo({ archivos: archivosSrc, leer, modo: 'src' });
  const { grafo: grafoLib } = construirGrafo({ archivos: archivosLib, leer, modo: 'lib' });

  const { cambiados, nuevos } = modulosCambiados({ archivos: archivosSrc, leer, repoRoot, base });

  const cierres = new Map();
  const cierresLib = new Map();
  for (const n of desdeSrc) {
    cierres.set(n, cierreDeExport({ grafo: grafoSrc, entrada: srcIndex, nombre: n }));
    cierresLib.set(n, cierreDeExport({ grafo: grafoLib, entrada: libIndex, nombre: n }));
  }
  // El grafo compilado se recorre para CONFIRMAR el del fuente: si un export alcanza módulos en uno
  // y en el otro no, el cálculo no se puede usar para armar un selector.
  const divergencias = [];
  for (const n of desdeSrc) {
    const a = new Set([...cierres.get(n)].map((f) => relative(join(RAIZ_FUNCTIONS, 'src'), f).replace(/\\/g, '/').replace(/\.ts$/, '')));
    const b = new Set([...cierresLib.get(n)].map((f) => relative(join(RAIZ_FUNCTIONS, 'lib'), f).replace(/\\/g, '/').replace(/\.js$/, '')));
    const soloA = [...a].filter((x) => !b.has(x) && !x.startsWith('..'));
    const soloB = [...b].filter((x) => !a.has(x));
    if (soloA.length > 0 || soloB.length > 0) divergencias.push({ export: n, soloSrc: soloA, soloLib: soloB });
  }

  // --- producción (read-only) ---------------------------------------------------------------
  let desplegados = null;
  let schedulers = null;
  let numeros = null;
  if (leerProd) {
    ({ desplegados, schedulers, numeros } = await leerProd());
  } else if (projectId) {
    const fl = await leerFunctionsDesplegadas(projectId);
    desplegados = fl.nombres;
    schedulers = fl.schedulers;
    numeros = await leerNumerosRuteados(projectId);
  }

  const precondicion = numeros ? verificarPrecondicionDeMigracion(numeros) : null;
  const superficie = desplegados
    ? clasificarSuperficie({ exportados: desdeSrc, desplegados, cambiados, cierres })
    : null;

  const v = veredictoDeRelease({ precondicion, superficie, divergencias, noResueltos });

  return {
    veredicto: v.veredicto,
    bloqueos: v.bloqueos,
    base,
    exports: { total: desdeSrc.length, perdidosPorRegexDeLinea: perdidosPorLinea.length, coincidenSrcYLib: true },
    grafo: {
      archivosSrc: archivosSrc.length,
      archivosLib: archivosLib.length,
      importsNoResueltos: noResueltos,
      divergencias,
      modulosCambiados: cambiados.size,
      modulosNuevos: nuevos.length,
    },
    precondicionMigracion: precondicion,
    superficie,
    schedulersDesplegados: schedulers,
    // Selector listo para pegar, SOLO informativo: este script no despliega. Un veredicto
    // BLOQUEADO no devuelve selector — un informe bloqueado no puede ofrecer nada copiable.
    selectorSugerido: v.selector,
  };
}

// ----------------------------------- CLI -----------------------------------
const esMain = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('scripts/release-audit.mjs');
if (esMain) {
  const arg = (n) => {
    const i = process.argv.indexOf(`--${n}`);
    const v = i >= 0 ? (process.argv[i + 1] ?? '') : '';
    return v.startsWith('--') ? '' : v;
  };
  const sinRed = process.argv.includes('--sin-red');
  const projectId = arg('project');
  const base = arg('base') || COMMIT_BASE_DESPLEGADO;
  if (!sinRed && !projectId) {
    console.log('uso: node scripts/release-audit.mjs --project <projectId> [--base <ref>] [--json]');
    console.log('     node scripts/release-audit.mjs --sin-red   (solo grafo, sin leer producción)');
    process.exit(2);
  }
  const informe = await auditarRelease({ base, projectId: sinRed ? null : projectId });
  if (process.argv.includes('--json')) console.log(JSON.stringify(informe, null, 2));
  else {
    console.log(`veredicto: ${informe.veredicto}${informe.bloqueos?.length ? ' — ' + informe.bloqueos.join(', ') : ''}`);
    console.log(JSON.stringify({ ...informe, selectorSugerido: undefined }, null, 2));
    if (informe.selectorSugerido) console.log(`\n--only ${informe.selectorSugerido}`);
  }
  process.exitCode = informe.veredicto === 'BLOQUEADO' ? 1 : 0;
}
